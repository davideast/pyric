/**
 * Installs an app the way a user does: the app's own package.json, `npm
 * install`, real registry packages for everything that is not Pyric. The
 * Pyric packages come from packed tarballs, never from workspace sources.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { endGroup, watchChildExit } from './unreaped-exit.ts';

/** How long a process a command left behind gets after SIGTERM, before SIGKILL. */
const LEFTOVER_TERM_MS = 1000;

/** The published packages, in the order scripts/pack-packages.sh packs them. */
const PUBLISHED_PACKAGE_DIRS = [
  'packages/pyric',
  'packages/pyric-admin',
  'packages/create-pyric',
  'packages/cli',
  'packages/ui',
];

/** Files in an app directory that drive it and are not part of the app. */
const DRIVER_FILES = new Set(['scenario.ts', 'README.md', 'node_modules', '.pyric']);

export type Tarballs = Map<string, string>;

function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

/** The tarball of each published package in `dir`, named as `npm pack` names them. */
export function tarballsIn(root: string, dir: string): Tarballs {
  const tarballs: Tarballs = new Map();
  for (const packageDir of PUBLISHED_PACKAGE_DIRS) {
    const manifest = JSON.parse(readFileSync(join(root, packageDir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    const file = resolve(dir, tarballName(manifest.name, manifest.version));
    if (!existsSync(file)) throw new Error(`missing packed package ${manifest.name}: ${file}`);
    tarballs.set(manifest.name, file);
  }
  return tarballs;
}

export interface CommandResult {
  code: number | null;
  output: string;
}

/**
 * Runs a command to exit. An exit the runner only half sees (#1274), a child
 * whose pipes a process it started holds open, or one never reaped, resolves
 * too (watchChildExit).
 */
export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; spawnChild?: (command: string, args: string[], options: SpawnOptions) => ChildProcess },
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const spawnChild = options.spawnChild ?? spawn;
    // Its own process group, so what it starts and leaves running can be found and ended.
    const child = spawnChild(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    const stopWatching = watchChildExit(child, command, (exit) => {
      const hasLeftovers = exit.leftovers.length > 0 && child.pid !== undefined;
      if (hasLeftovers) void endGroup(child.pid ?? 0, LEFTOVER_TERM_MS);
      resolvePromise({ code: exit.code, output: `${output}${exit.note}` });
    });
    child.on('error', (error) => {
      stopWatching();
      reject(error);
    });
  });
}

/** Packs the published packages into dist/packages and returns their tarballs. */
export async function packWorkspace(root: string, build: boolean): Promise<Tarballs> {
  const args = ['scripts/pack-packages.sh', ...(build ? [] : ['--skip-build'])];
  const result = await runCommand('bash', args, { cwd: root });
  if (result.code !== 0) throw new Error(`packing failed (exit ${result.code}):\n${result.output}`);
  return tarballsIn(root, join(root, 'dist/packages'));
}

/**
 * Copies the app into `projectDir` and points its Pyric dependencies at the
 * tarballs. The overrides pin every Pyric package to its tarball, so the
 * packages' dependencies on each other resolve locally too. `npm install`
 * runs next, through `SharedInstalls`.
 */
export function prepareApp(options: { appDir: string; projectDir: string; tarballs: Tarballs }): void {
  for (const entry of readdirSync(options.appDir)) {
    if (DRIVER_FILES.has(entry)) continue;
    cpSync(join(options.appDir, entry), join(options.projectDir, entry), { recursive: true });
  }
  pinPyricPackages(options.projectDir, options.tarballs);
}

/**
 * Points the Pyric dependencies in `projectDir/package.json` at the tarballs
 * and pins every Pyric package to its tarball through `overrides`. Also used
 * for a project a scenario creates, such as one `create-pyric` scaffolds.
 */
export function pinPyricPackages(projectDir: string, tarballs: Tarballs): void {
  const manifestPath = join(projectDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const pins = Object.fromEntries([...tarballs].map(([name, file]) => [name, `file:${file}`]));
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const dependencies = manifest[field] as Record<string, string> | undefined;
    if (!dependencies) continue;
    for (const name of Object.keys(dependencies)) {
      if (pins[name]) dependencies[name] = pins[name];
    }
  }
  manifest.overrides = { ...(manifest.overrides as object | undefined), ...pins };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * How long npm waits on one registry request before it fails it and retries
 * it itself. npm's default is 5 minutes, longer than an install gets here, so
 * a stalled request would end as a silent kill instead of an npm error (#1476).
 */
const FETCH_TIMEOUT_MS = 60_000;

/**
 * `npm install` as the runner runs it: quiet, with the shared cache. Offline
 * first by default; `online` revalidates the cached package listings. With
 * `logsDir`, npm writes its debug log there, so a hang can be read back.
 */
export function npmInstallArgs(npmCache: string, metadata: 'offline' | 'online' = 'offline', logsDir?: string): string[] {
  const quiet = ['--no-audit', '--no-fund', '--loglevel=error', '--progress=false', '--update-notifier=false'];
  const logs = logsDir ? [`--logs-dir=${logsDir}`] : [];
  return ['install', ...quiet, `--fetch-timeout=${FETCH_TIMEOUT_MS}`, `--prefer-${metadata}`, '--cache', npmCache, ...logs];
}

/** npm's codes for a version range the cached package listing has no match for. */
const STALE_METADATA = /\bcode (ETARGET|ENOVERSIONS)\b/;

/**
 * Whether a failed install is explained by stale cached metadata. With
 * `--prefer-offline`, npm trusts a cached package listing, so a dependency
 * that asks for a version published after the listing was cached fails with
 * ETARGET (#1246). The version exists; the listing is old.
 */
export function shouldRetryOnline(result: CommandResult): boolean {
  const isFailure = result.code !== 0;
  return isFailure && STALE_METADATA.test(result.output);
}

/** Run `npm install` offline first, and once more with `--prefer-online` when stale metadata failed it. */
export async function npmInstall<R extends CommandResult>(
  npmCache: string,
  run: (args: string[]) => Promise<R>,
  logsDir?: string,
): Promise<R> {
  const first = await run(npmInstallArgs(npmCache, 'offline', logsDir));
  if (!shouldRetryOnline(first)) return first;
  const note = '\n[runner] npm install failed on stale cached metadata; retrying once with --prefer-online\n';
  const second = await run(npmInstallArgs(npmCache, 'online', logsDir));
  return { ...second, output: `${first.output}${note}${second.output}` };
}

/**
 * How long one nested `npm install` (`app.installProject`) gets before the
 * runner calls it hung. A passing one takes well under this on CI; a hung one
 * never finished in 240 s (#1476). Two attempts and the rest of a scenario
 * still fit in the app's 300 s.
 */
export const NESTED_INSTALL_ATTEMPT_MS = 150_000;

export interface TimedResult extends CommandResult {
  /** True when the runner stopped the command at its time limit. */
  timedOut: boolean;
}

function outcome(result: TimedResult): string {
  return result.timedOut ? 'timed out' : `exited ${result.code}`;
}

function secondsSince(started: number): number {
  return Math.round((performance.now() - started) / 1000);
}

/**
 * Runs `attempt`, and once more after `reset` when it timed out. This is an
 * infrastructure retry: an attempt that exits, with any code, is never run
 * again. `report` gets one line every run, retried or not, so CI logs can
 * count how often the retry happens and what it costs (#1485).
 */
export async function retryOnceOnTimeout(
  attempt: () => Promise<TimedResult>,
  options: { what: string; reset: () => Promise<void>; report: (line: string) => void },
): Promise<TimedResult> {
  const started = performance.now();
  const first = await attempt();
  if (!first.timedOut) {
    options.report(`[runner] ${options.what} ${outcome(first)} in ${secondsSince(started)} s, 1 attempt`);
    return first;
  }
  options.report(`[runner] infrastructure retry: ${options.what} timed out after ${secondsSince(started)} s; trying it once more`);
  await options.reset();
  const second = await attempt();
  options.report(`[runner] ${options.what} ${outcome(second)} in ${secondsSince(started)} s, 2 attempts (1 infrastructure retry)`);
  const note = '\n[runner] infrastructure retry: the attempt above timed out; trying it once more\n';
  return { ...second, output: `${first.output}${note}${second.output}` };
}

/** The last `lines` lines of the newest npm debug log in `logsDir`, named, or a note that there is none. */
export function debugLogTail(logsDir: string, lines: number): string {
  const logs = existsSync(logsDir) ? readdirSync(logsDir).filter((name) => name.endsWith('.log')).sort() : [];
  const newest = logs.at(-1);
  if (!newest) return `[runner] no npm debug log in ${logsDir}\n`;
  const text = readFileSync(join(logsDir, newest), 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  return `[runner] the end of npm's debug log ${newest}:\n${text}\n`;
}
