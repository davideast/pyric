/**
 * Sets up a factory run's app before its first session: mdmedia, cloned from
 * a local repo at a pinned commit, with Studio installed on the packed Pyric
 * packages, so Studio runs on the checkout's Pyric and on nothing published.
 *
 * 1. Clones the source into `<runDir>/app` with no remote left, at the commit
 *    (the source's HEAD unless one is named). A clone has only committed files:
 *    no `.env*`, no `.pyric-local`, no build output.
 * 2. Lays out the run's host directory: the Pyric tarballs in `packages/`,
 *    the harness's ast-grep and the source checkout's ffmpeg in `tools/`
 *    with their hashes, and a bare repo in `git/`.
 * 3. Installs the repo root on the host (`bun install --frozen-lockfile
 *    --ignore-scripts`: the source commit, before any session exists, and the
 *    only install that reaches the registry) and, inside the sandbox, builds
 *    the `mdmedia` engine and packs it. Studio depends on it as
 *    `file:../mdmedia-0.1.0.tgz`, which no clone has.
 * 4. Commits one change on a `factory` branch: Studio's Pyric and engine
 *    dependencies pinned to those tarballs, Studio's `next.config.ts`
 *    adapted to that Pyric's `withPyric` (`next-config.ts`), and the
 *    factory's UI rules registered in Studio's ast-grep config. `app.json`
 *    lists the adaptations. That commit is the run's start commit; the UI
 *    gates judge every change after it. It is fetched into the bare repo.
 * 5. Installs the UI rules into `studio/checks/`, kept out of git by
 *    `.git/info/exclude`, then installs Studio inside the sandbox, which
 *    warms the shared npm cache every later install reads.
 * 6. Writes `app.json` in the host directory.
 *
 * `run.json` is the supervisor's, written when `factory --hours` starts the
 * run, and that command refuses a directory that already has one; so the
 * commits are recorded in `app.json`.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Tarballs } from '../../apps/install.ts';
import { dataRoot } from '../round-paths.ts';
import { appPaths, type AppPaths } from './app-paths.ts';
import { hostRunner, mustRun, type Runner } from './exec.ts';
import { cloneWithoutRemote, fetchHead, git, headCommit, initBareRepo } from './git.ts';
import { makeHostDir, writeNewFile } from './host-files.ts';
import { adaptNextConfig, NEXT_CONFIG } from './next-config.ts';
import { installUiRules, registerUiRules } from './rules-install.ts';
import { openSandbox as realSandbox, type SandboxOpener, type SandboxSpec } from './sandbox.ts';
import { readJson, writeJson } from './state-files.ts';
import { installStudio } from './studio-install.ts';
import { AST_GREP, FFMPEG, harnessAstGrep, placeTool, sourceFfmpeg, type ToolHashes } from './tools.ts';

export const ENGINE_TARBALL = 'mdmedia-0.1.0.tgz';
/** The brief's list of new `components/ui` files a run may add. */
export const APPROVED_COMPONENTS = 'approved-components.txt';
const BRANCH = 'factory';
const ENGINE_TIMEOUT_MS = 10 * 60_000;
const ROOT_INSTALL_TIMEOUT_MS = 10 * 60_000;

export function defaultBriefDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataRoot(env), 'briefs', 'factory', 'mdmedia');
}

const recordSchema = z.object({
  source: z.string(),
  sourceCommit: z.string(),
  startCommit: z.string(),
  setupAt: z.string().datetime(),
  briefDir: z.string(),
  /** What setup changed in Studio's code to run on the pinned Pyric. */
  adaptations: z.array(z.string()),
  /** Each tool in `tools/` by its sha256. */
  tools: z.record(z.string().regex(/^[0-9a-f]{64}$/)),
}).strict();

export type AppRecord = z.infer<typeof recordSchema>;

export function readAppRecord(paths: AppPaths): AppRecord {
  const record = readJson(paths.record, recordSchema);
  if (record === undefined) throw new Error(`${paths.record} is missing: run factory-setup first`);
  return record;
}

export interface SetupOptions {
  runDir: string;
  source: string;
  commit?: string;
  briefDir?: string;
  tarballs: Tarballs;
  openSandbox?: SandboxOpener;
  say: (line: string) => void;
}

function copyTarballs(paths: AppPaths, tarballs: Tarballs): Tarballs {
  const copied: Tarballs = new Map();
  for (const [name, file] of tarballs) {
    const target = join(paths.packages, basename(file));
    copyFileSync(file, target);
    copied.set(name, target);
  }
  return copied;
}

/** A setup sandbox: rooted at the run directory, before any session exists, with a network record per step. */
function setupSpec(paths: AppPaths, step: string): SandboxSpec {
  const { app } = paths;
  return { root: app.root, networkLog: join(app.logs, `${step}.network.jsonl`), home: app.home, readOnly: [] };
}

async function packEngine(runner: Runner, paths: AppPaths): Promise<string> {
  const { repo } = paths.app;
  const staging = join(paths.app.logs, '..');
  await mustRun(runner, { command: 'bun', args: ['run', 'build'], cwd: repo, timeoutMs: ENGINE_TIMEOUT_MS }, 'building the mdmedia engine');
  const args = ['pack', '--ignore-scripts', '--pack-destination', staging];
  await mustRun(runner, { command: 'npm', args, cwd: repo, timeoutMs: ENGINE_TIMEOUT_MS }, 'packing the mdmedia engine');
  return join(staging, ENGINE_TARBALL);
}

/**
 * Copies the brief's list of approved new `components/ui` files into the host
 * directory, which is what the check reads and no session can write. A brief
 * without one approves nothing. The brief is the harness's input, but a link
 * there is refused rather than followed.
 */
export function seedApprovedComponents(briefDir: string, paths: Pick<AppPaths, 'approvedComponents'>): boolean {
  const source = join(briefDir, APPROVED_COMPONENTS);
  const stat = lstatSync(source, { throwIfNoEntry: false });
  if (stat === undefined) return false;
  if (!stat.isFile()) throw new Error(`${source} is not a regular file`);
  writeNewFile(paths.approvedComponents, readFileSync(source, 'utf8'));
  return true;
}

/** Copies the packed engine into `packages/`: a regular file, written by the source commit's own build. */
function keepEngine(paths: AppPaths, packed: string): string {
  const isRegularFile = lstatSync(packed).isFile();
  if (!isRegularFile) throw new Error(`${packed} is not a regular file`);
  const target = join(paths.packages, ENGINE_TARBALL);
  copyFileSync(packed, target);
  return target;
}

/** Points Studio's Pyric packages and engine at the run's tarballs; `overrides` pin Pyric's own dependencies on each other too. */
export function pinStudio(studio: string, tarballs: Tarballs, engine: string): void {
  const manifestPath = join(studio, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const pins: Record<string, string> = Object.fromEntries([...tarballs].map(([name, file]) => [name, `file:${file}`]));
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const dependencies = manifest[field] as Record<string, string> | undefined;
    if (dependencies === undefined) continue;
    for (const name of Object.keys(dependencies)) {
      const pin = pins[name];
      if (pin !== undefined) dependencies[name] = pin;
    }
    if (dependencies.mdmedia !== undefined) dependencies.mdmedia = `file:${engine}`;
  }
  manifest.overrides = { ...(manifest.overrides as object | undefined), ...pins };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function commitStart(paths: AppPaths): string {
  const { repo } = paths.app;
  git(repo, ['add', 'studio/package.json', `studio/${NEXT_CONFIG}`, 'studio/checks/sgconfig.yml']);
  git(repo, ['commit', '--quiet', '-m', 'chore(factory): run Studio on the run\'s packed Pyric packages and UI rules']);
  return headCommit(repo);
}

function placeTools(paths: AppPaths, source: string, say: (line: string) => void): ToolHashes {
  const tools: ToolHashes = { [AST_GREP]: placeTool(paths.tools, AST_GREP, harnessAstGrep()) };
  const ffmpeg = sourceFfmpeg(source);
  if (ffmpeg === undefined) say('the source checkout has no ffmpeg; Studio\'s media tests will fail');
  else tools[FFMPEG] = placeTool(paths.tools, FFMPEG, ffmpeg);
  return tools;
}

function makeLayout(paths: AppPaths): void {
  makeHostDir(paths.host, paths.host, paths.runDir);
  for (const dir of [paths.packages, paths.tools, paths.checks]) makeHostDir(dir, paths.host, paths.runDir);
  initBareRepo(paths.gitDir);
}

/** Installs the source commit's repo root on the host, before any session exists. */
async function installSourceRoot(paths: AppPaths): Promise<void> {
  const args = ['install', '--frozen-lockfile', '--ignore-scripts'];
  await mustRun(hostRunner(paths.app.home), { command: 'bun', args, cwd: paths.app.repo, timeoutMs: ROOT_INSTALL_TIMEOUT_MS }, 'bun install at the repo root');
}

export async function setupApp(options: SetupOptions): Promise<AppRecord> {
  const paths = appPaths(options.runDir);
  const { say } = options;
  const opener = options.openSandbox ?? realSandbox;
  if (existsSync(paths.record)) throw new Error(`${paths.record} exists: this run's app is already set up`);
  const hasClone = existsSync(paths.app.repo) && readdirSync(paths.app.repo).length > 0;
  if (hasClone) throw new Error(`${paths.app.repo} is not empty; set up a new run directory`);
  makeLayout(paths);
  for (const dir of [paths.app.home, paths.app.logs]) mkdirSync(dir, { recursive: true });
  const seeded = seedApprovedComponents(options.briefDir ?? defaultBriefDir(), paths);
  say(seeded ? `approved components from the brief's ${APPROVED_COMPONENTS}` : `the brief has no ${APPROVED_COMPONENTS}: a run may add no components/ui file`);
  const sourceCommit = options.commit ?? headCommit(options.source);
  say(`cloning ${options.source} at ${sourceCommit} into ${paths.app.repo}`);
  cloneWithoutRemote(options.source, paths.app.repo);
  git(paths.app.repo, ['checkout', '--quiet', '-B', BRANCH, sourceCommit]);
  const tools = placeTools(paths, options.source, say);
  const tarballs = copyTarballs(paths, options.tarballs);
  say('bun install at the repo root, on the host, at the source commit');
  await installSourceRoot(paths);
  say('building and packing the mdmedia engine inside the sandbox');
  const packed = await opener(setupSpec(paths, 'engine'), paths, (runner) => packEngine(runner, paths));
  const engine = keepEngine(paths, packed);
  pinStudio(paths.app.studio, tarballs, engine);
  const adaptations = adaptNextConfig(paths.app.studio);
  for (const line of adaptations) say(`adapted ${line}`);
  registerUiRules(paths.app.studio);
  const startCommit = commitStart(paths);
  const fetched = fetchHead(paths.gitDir, paths.app.repo);
  if (fetched !== startCommit) throw new Error(`the harness's repo fetched ${fetched}, not the start commit ${startCommit}`);
  say(`start commit ${startCommit}`);
  installUiRules(paths.app.repo);
  say('installing Studio in the roles\' clone, inside the sandbox');
  // The one install that may fall back to the host on a cold cache: the start commit's, which warms it.
  const install = { checkout: paths.app, withRoot: false, outsideInstall: 'allowed' as const, say };
  await opener(setupSpec(paths, 'install'), paths, (runner, namespace) => installStudio({ ...install, runner, namespace }));
  const record: AppRecord = {
    source: options.source,
    sourceCommit,
    startCommit,
    setupAt: new Date().toISOString(),
    briefDir: options.briefDir ?? defaultBriefDir(),
    adaptations,
    tools,
  };
  writeJson(paths.record, record);
  return record;
}
