/**
 * The canary: a scripted builder with no model, and the harness's integration
 * test. It installs the packed packages into a scratch app the way a builder
 * run does, then, inside the run's sandbox, starts the app's Vite
 * dev server and a `node --import @pyric/cli/register` script under the
 * recorder and plants requests to Google hosts and the metadata server from
 * Node, from the harness browser, and from clients no recorder hooks (Bun,
 * curl). It checks that each one is in the network record and was refused by
 * the layer meant to refuse it, while a local request works and is not
 * flagged.
 *
 * Everything it makes stays under `<builders root>/canary/<stamp>/`.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@playwright/test';
import { takeHeavyRunSlot } from '../../../scripts/lib/heavy-run-slots.ts';
import { AppRun } from '../../apps/driver.ts';
import { npmInstall, npmOfflineInstallArgs, packWorkspace, prepareApp, runCommand, tarballsIn, type CommandResult, type Tarballs } from '../../apps/install.ts';
import { playwrightBrowsersPath } from '../browser-server.ts';
import { startEgressNamespace, type EgressNamespace } from '../namespace.ts';
import { browserEvents, readNetLog } from '../recorder/chromium-netlog.ts';
import { appendBrowserEvents, readNetworkRecord } from '../recorder/network-record.ts';
import { buildersRoot, createRunDirs, demoProjectId, recorderEnvironment, runStamp, writeFakeFirebaseConfig, type RunDirs } from '../scratch.ts';
import { PLANTS_FILE, type PlantOutput } from './plant-phase.ts';
import { judgeCanary, type CanaryVerdict } from './verdict.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CANARY_APP = fileURLToPath(new URL('./app', import.meta.url));
const PLANT_PHASE = fileURLToPath(new URL('./plant-phase.ts', import.meta.url));
const BUILDERS_TESTS = fileURLToPath(new URL('..', import.meta.url));

const INSTALL_TIMEOUT_MS = 300_000;
/** The registry the shared cache was warmed from; an offline install reads its cached listings under this URL. */
const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** What npm says when an offline install needs something the cache doesn't hold. */
const COLD_CACHE = /\bENOTCACHED\b/;
/** No package's install scripts run, inside the sandbox or out. */
const IGNORE_SCRIPTS = '--ignore-scripts';

export interface CanaryOptions {
  /** Build the workspace before packing it. */
  build: boolean;
  /** Install these tarballs instead of packing the workspace. */
  packages?: string;
}

function step(line: string): void {
  console.log(`▸ ${line}`);
}

async function runUnitTests(): Promise<void> {
  step('unit tests: bun test test/builders');
  const result = await runCommand('bun', ['test', BUILDERS_TESTS], { cwd: REPO_ROOT });
  if (result.code !== 0) throw new Error(`the builder unit tests failed (exit ${result.code}):\n${result.output}`);
}

async function packages(options: CanaryOptions): Promise<Tarballs> {
  if (options.packages !== undefined) {
    step(`installing packages from ${options.packages}`);
    return tarballsIn(REPO_ROOT, options.packages);
  }
  step(`packing the workspace${options.build ? ' (with a build)' : ' (current build)'}`);
  return packWorkspace(REPO_ROOT, options.build);
}

/** AppRun's own browser is never used: the plant phase drives the harness browser. */
const noDriverBrowser = (): Promise<Browser> => Promise.reject(new Error('the canary uses the harness browser server'));

function npmCacheDir(): string {
  return process.env.PYRIC_APPS_NPM_CACHE ?? join(homedir(), '.cache', 'pyric-app-scenarios-npm');
}

/**
 * `npm install --ignore-scripts --offline` inside the sandbox, from the warm
 * shared cache (read-only, under an overlay whose writes stay in the
 * sandbox), under the Node recorder. Only when the
 * cache is cold for this app does it install outside the sandbox, still with
 * `--ignore-scripts` and under the recorder, which refuses any Google host;
 * the kernel does not block that one. Nothing is planted in either.
 */
async function install(namespace: EgressNamespace, dirs: RunDirs): Promise<void> {
  step('npm install --ignore-scripts --offline, from the warm cache, inside the sandbox');
  const app = new AppRun('builders-canary install', dirs.app, dirs.home, noDriverBrowser);
  const npmCache = npmCacheDir();
  const recorded = recorderEnvironment(dirs.networkLog);
  const run = (command: string, args: string[]) => app.command(command, args, { env: recorded, timeoutMs: INSTALL_TIMEOUT_MS });
  try {
    const offlineArgs = [...npmOfflineInstallArgs(npmCache, NPM_REGISTRY), IGNORE_SCRIPTS, `--logs-dir=${dirs.logs}`];
    const entered = namespace.enter('npm', offlineArgs, dirs.app);
    const inside = await run(entered.command, entered.args);
    writeFileSync(join(dirs.logs, '00-npm-install-sandbox.log'), inside.output);
    if (inside.code === 0) return;
    if (!isColdCache(inside)) throw new Error(`npm install inside the sandbox failed (exit ${inside.code}):\n${inside.output}`);
    step('the npm cache is cold for this app: npm install --ignore-scripts outside the sandbox, under the recorder');
    const outside = await npmInstall(npmCache, (args) => run('npm', [...args, IGNORE_SCRIPTS]));
    writeFileSync(join(dirs.logs, '00-npm-install-outside.log'), outside.output);
    if (outside.code !== 0) throw new Error(`npm install failed (exit ${outside.code}):\n${outside.output}`);
  } finally {
    await app.close();
  }
}

/** Whether an offline install failed only because the cache lacks something the app needs. */
export function isColdCache(result: CommandResult): boolean {
  return result.code !== 0 && COLD_CACHE.test(result.output);
}

/** Runs the plant phase inside the run's sandbox and reads what it wrote. */
async function plantInNamespace(namespace: EgressNamespace, dirs: RunDirs): Promise<PlantOutput> {
  step('plant phase, inside the sandbox');
  const { command, args } = namespace.enter(process.execPath, [PLANT_PHASE, dirs.root], REPO_ROOT);
  const result = await runCommand(command, args, { cwd: REPO_ROOT });
  process.stdout.write(result.output);
  if (result.code !== 0) throw new Error(`the plant phase exited ${result.code}`);
  return JSON.parse(readFileSync(join(dirs.root, PLANTS_FILE), 'utf8')) as PlantOutput;
}

function printVerdict(verdict: CanaryVerdict, dirs: RunDirs): void {
  console.log('');
  for (const check of verdict.checks) console.log(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
  console.log('');
  console.log(`${verdict.googleEvents} Google-host or metadata events in ${dirs.networkLog}`);
  console.log(verdict.ok ? '✓ canary passed' : '✗ canary failed: a planted request was missed, succeeded, or was stopped by the wrong layer, or a local one was blocked');
}

/** The package directories `scripts/pack-packages.sh` packs, read from its `PACKAGES=(...)` list. */
export function packedPackageDirs(repoRoot: string): string[] {
  const script = readFileSync(join(repoRoot, 'scripts', 'pack-packages.sh'), 'utf8');
  const list = /^PACKAGES=\(([^)]*)\)/m.exec(script)?.[1] ?? '';
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '').filter((dir) => dir !== '');
}

/** Why the canary can't start in this checkout, said before anything runs. */
export class PreflightFailed extends Error {}

const isInside = (path: string, dir: string) => path === dir || path.startsWith(`${dir.replace(/\/+$/, '')}/`);

/**
 * What this checkout lacks for a canary run. The sandbox binds only the repo,
 * so its node_modules must be its own (a worktree that links another
 * checkout's has none inside the sandbox). Without `--build` or
 * `--packages`, every published package needs a current dist/ to pack.
 */
export function preflightProblems(repoRoot: string, options: CanaryOptions): string[] {
  const problems: string[] = [];
  const nodeModules = join(repoRoot, 'node_modules');
  const playwright = join(nodeModules, '@playwright', 'test');
  if (!existsSync(playwright)) {
    problems.push(`${repoRoot} has no node_modules/@playwright/test of its own: run \`bun install\` there first`);
  } else if (!isInside(realpathSync(nodeModules), realpathSync(repoRoot))) {
    problems.push(`${nodeModules} links outside the repo (${realpathSync(nodeModules)}), which the sandbox does not bind: run \`bun install\` in this checkout`);
  }
  const packsCurrentBuild = !options.build && options.packages === undefined;
  if (packsCurrentBuild) {
    const packed = packedPackageDirs(repoRoot);
    if (packed.length === 0) problems.push(`found no PACKAGES list in ${join(repoRoot, 'scripts', 'pack-packages.sh')}`);
    const unbuilt = packed.filter((dir) => !existsSync(join(repoRoot, dir, 'dist')));
    if (unbuilt.length > 0) problems.push(`no dist/ in ${unbuilt.join(', ')}: run with --build, or build first, or pass --packages <dir>`);
  }
  if (options.packages !== undefined && !existsSync(resolve(options.packages))) problems.push(`--packages ${options.packages} does not exist`);
  return problems;
}

/** Runs the canary. Resolves true when every check passed. */
export async function runCanary(options: CanaryOptions): Promise<boolean> {
  const problems = preflightProblems(REPO_ROOT, options);
  if (problems.length > 0) throw new PreflightFailed(`the canary can't run in this checkout:\n- ${problems.join('\n- ')}`);
  await runUnitTests();
  const slot = await takeHeavyRunSlot({ command: 'bun test/builders/harness.ts canary' });
  try {
    const stamp = runStamp();
    const dirs = createRunDirs(join(buildersRoot(), 'canary', stamp));
    step(`run directory ${dirs.root}`);
    // Started first, so a machine without the sandbox refuses before any work.
    step('starting the sandbox: allowlisted files, loopback only, a recording resolver and catch-all listener');
    const readOnly = [playwrightBrowsersPath(), ...(options.packages === undefined ? [] : [resolve(options.packages)])];
    const namespace = await startEgressNamespace({ networkLog: dirs.networkLog, runRoot: dirs.root, readOnly, overlaid: [npmCacheDir()] });
    let output: PlantOutput;
    try {
      const tarballs = await packages(options);
      prepareApp({ appDir: CANARY_APP, projectDir: dirs.app, tarballs });
      writeFakeFirebaseConfig(dirs.app, demoProjectId(`canary-${stamp.slice(0, 10)}`));
      await install(namespace, dirs);
      output = await plantInNamespace(namespace, dirs);
    } finally {
      await namespace.stop();
    }
    appendBrowserEvents(dirs.networkLog, browserEvents(readNetLog(readFileSync(dirs.netLog, 'utf8'))));
    const verdict = judgeCanary({ ...output, record: readNetworkRecord(dirs.networkLog) });
    writeFileSync(join(dirs.root, 'canary.json'), `${JSON.stringify({ ...output, verdict }, null, 2)}\n`);
    printVerdict(verdict, dirs);
    return verdict.ok;
  } finally {
    slot.release();
  }
}
