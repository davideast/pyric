/**
 * Sets up a factory run's app before its first session: mdmedia, cloned from
 * a local repo at a pinned commit, with Studio installed on the packed Pyric
 * packages, so Studio runs on the checkout's Pyric and on nothing published.
 *
 * 1. Clones the source into `<runDir>/app` with no remote left, at the commit
 *    (the source's HEAD unless one is named). A clone has only committed files:
 *    no `.env*`, no `.pyric-local`, no build output.
 * 2. Copies the Pyric tarballs into `<runDir>/packages/`.
 * 3. Installs the repo root (`bun install --frozen-lockfile --ignore-scripts`,
 *    on the host, the only step that reaches the registry besides a cold npm
 *    cache) and, inside the sandbox, builds the `mdmedia` engine and packs it
 *    there too. Studio depends on it as `file:../mdmedia-0.1.0.tgz`, which no
 *    clone has.
 * 4. Commits one change on a `factory` branch: Studio's Pyric and engine
 *    dependencies pinned to those tarballs, Studio's `next.config.ts`
 *    adapted to that Pyric's `withPyric` (`next-config.ts`), and the
 *    factory's UI rules registered in Studio's ast-grep config. `app.json`
 *    lists the adaptations. That commit is the run's start
 *    commit; the UI gates judge every change after it.
 * 5. Installs the UI rules themselves into `studio/checks/`, kept out of git
 *    by `.git/info/exclude`, then installs Studio inside the sandbox
 *    (`app-install.ts`), and runs Studio's own postinstall patch, since the
 *    install runs no scripts.
 * 6. Prepares the check's checkout the same way, and writes `app.json`.
 *
 * `run.json` is the supervisor's, written when `factory --hours` starts the
 * run, and that command refuses a directory that already has one; so the
 * commits are recorded in `app.json` beside it.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Tarballs } from '../../apps/install.ts';
import { dataRoot } from '../round-paths.ts';
import { appPaths, type AppPaths, type Checkout } from './app-paths.ts';
import { mustRun, type Runner } from './exec.ts';
import { checkoutCommit, cloneWithoutRemote, git, headCommit } from './git.ts';
import { fetchFfmpeg } from './ffmpeg.ts';
import { adaptNextConfig, NEXT_CONFIG } from './next-config.ts';
import { installRoot, installStudio, type SandboxOpener } from './studio-install.ts';
import { installUiRules, registerUiRules } from './rules-install.ts';
import { writeJsonFile } from './run-dir.ts';

export const ENGINE_TARBALL = 'mdmedia-0.1.0.tgz';
const BRANCH = 'factory';
const ENGINE_TIMEOUT_MS = 10 * 60_000;

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
  adaptations: z.array(z.string()).optional(),
}).strict();

export type AppRecord = z.infer<typeof recordSchema>;

export function readAppRecord(paths: AppPaths): AppRecord {
  if (!existsSync(paths.record)) throw new Error(`${paths.record} is missing: run factory-setup first`);
  return recordSchema.parse(JSON.parse(readFileSync(paths.record, 'utf8')));
}

export interface SetupOptions {
  runDir: string;
  source: string;
  commit?: string;
  briefDir?: string;
  tarballs: Tarballs;
  openSandbox: SandboxOpener;
  say: (line: string) => void;
}

function copyTarballs(paths: AppPaths, tarballs: Tarballs): Tarballs {
  mkdirSync(paths.packages, { recursive: true });
  const copied: Tarballs = new Map();
  for (const [name, file] of tarballs) {
    const target = join(paths.packages, basename(file));
    copyFileSync(file, target);
    copied.set(name, target);
  }
  return copied;
}

async function packEngine(runner: Runner, paths: AppPaths): Promise<string> {
  const { repo } = paths.app;
  await mustRun(runner, { command: 'bun', args: ['run', 'build'], cwd: repo, timeoutMs: ENGINE_TIMEOUT_MS }, 'building the mdmedia engine');
  const args = ['pack', '--ignore-scripts', '--pack-destination', paths.packages];
  await mustRun(runner, { command: 'npm', args, cwd: repo, timeoutMs: ENGINE_TIMEOUT_MS }, 'packing the mdmedia engine');
  return join(paths.packages, ENGINE_TARBALL);
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

/** Makes or updates a checkout of `commit` from the roles' clone, with its UI rules and installs. */
export async function prepareCheckout(paths: AppPaths, checkout: Checkout, commit: string, options: { openSandbox: SandboxOpener; withRoot: boolean; say: (line: string) => void }): Promise<void> {
  mkdirSync(checkout.root, { recursive: true });
  if (!existsSync(join(checkout.repo, '.git'))) cloneWithoutRemote(paths.app.repo, checkout.repo);
  checkoutCommit(checkout.repo, paths.app.repo, commit);
  installUiRules(checkout.repo);
  await installStudio(paths, checkout, { ...options });
}

export async function setupApp(options: SetupOptions): Promise<AppRecord> {
  const paths = appPaths(options.runDir);
  const { say } = options;
  if (existsSync(paths.record)) throw new Error(`${paths.record} exists: this run's app is already set up`);
  const hasClone = existsSync(paths.app.repo) && readdirSync(paths.app.repo).length > 0;
  if (hasClone) throw new Error(`${paths.app.repo} is not empty; set up a new run directory`);
  const sourceCommit = options.commit ?? headCommit(options.source);
  say(`cloning ${options.source} at ${sourceCommit} into ${paths.app.repo}`);
  cloneWithoutRemote(options.source, paths.app.repo);
  git(paths.app.repo, ['checkout', '--quiet', '-B', BRANCH, sourceCommit]);
  const hasFfmpeg = fetchFfmpeg(paths, options.source);
  say(hasFfmpeg ? 'copied the source checkout\'s ffmpeg into tools/' : 'the source checkout has no ffmpeg; Studio\'s media tests will fail');
  const tarballs = copyTarballs(paths, options.tarballs);
  say('bun install at the repo root, on the host');
  await installRoot(paths.app);
  say('building and packing the mdmedia engine inside the sandbox');
  const engine = await options.openSandbox(paths.app.root, paths, (runner) => packEngine(runner, paths));
  pinStudio(paths.app.studio, tarballs, engine);
  const adaptations = adaptNextConfig(paths.app.studio);
  for (const line of adaptations) say(`adapted ${line}`);
  registerUiRules(paths.app.studio);
  const startCommit = commitStart(paths);
  say(`start commit ${startCommit}`);
  installUiRules(paths.app.repo);
  await installStudio(paths, paths.app, { openSandbox: options.openSandbox, withRoot: false, say });
  say('preparing the check\'s checkout');
  await prepareCheckout(paths, paths.check, startCommit, { openSandbox: options.openSandbox, withRoot: true, say });
  const record: AppRecord = {
    source: options.source,
    sourceCommit,
    startCommit,
    setupAt: new Date().toISOString(),
    briefDir: options.briefDir ?? defaultBriefDir(),
    adaptations,
  };
  writeJsonFile(paths.record, record);
  return record;
}
