/**
 * Installs an app the way a user does: the app's own package.json, `npm
 * install`, real registry packages for everything that is not Pyric. The
 * Pyric packages come from packed tarballs, never from workspace sources.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_EXIT_TIMING, describeGroupProcesses, endGroup, watchChildExit, type ExitTiming } from './unreaped-exit.ts';
import { childOutputSockets, describeOutputSockets, isExitWithoutClose } from './output-sockets.ts';

/** The waits `runCommand` uses. Tests pass short ones; the runner uses the defaults. */
export interface CommandTiming {
  exit: ExitTiming;
  /** How long a process a command left behind gets after SIGTERM, before SIGKILL. */
  leftoverTermMs: number;
}

const DEFAULT_COMMAND_TIMING: CommandTiming = { exit: DEFAULT_EXIT_TIMING, leftoverTermMs: 1000 };

/** The packages scripts/pack-packages.sh packs, in its order: the published ones and the @pyric/rules engine pyric depends on. */
const PUBLISHED_PACKAGE_DIRS = [
  'packages/rules',
  'packages/pyric',
  'packages/pyric-admin',
  'packages/create-pyric',
  'packages/cli',
  'packages/ui',
  'packages/live',
];

const PUBLISHED_PACKAGE_NAMES = new Set([
  '@pyric/rules',
  'pyric',
  'pyric-admin',
  'create-pyric',
  '@pyric/cli',
  '@pyric/ui',
  '@pyric/live',
]);

/** Files in an app directory that drive it and are not part of the app. */
const DRIVER_FILES = new Set(['scenario.ts', 'README.md', 'node_modules', '.pyric']);

export type Tarballs = Map<string, string>;

function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

/** The tarball of each published package in `dir`, named as `npm pack` names them. */
export function tarballsIn(root: string, dir: string): Tarballs {
  const manifestPath = join(dir, 'manifest.json');
  let packageDirs = PUBLISHED_PACKAGE_DIRS;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      packages?: Array<{ sourceDir?: string }>;
    };
    const listedDirs = manifest.packages
      ?.map((pkg) => pkg.sourceDir)
      .filter(
        (sourceDir): sourceDir is string =>
          typeof sourceDir === 'string' && PUBLISHED_PACKAGE_DIRS.includes(sourceDir),
      );
    if (listedDirs && listedDirs.length > 0) {
      packageDirs = listedDirs;
    }
  }
  const tarballs: Tarballs = new Map();
  for (const packageDir of packageDirs) {
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
  /** False when the command already exhausted its retry policy or hit a non-transient error. */
  retryable?: boolean;
}

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnChild?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  timing?: CommandTiming;
}

/**
 * Runs a command to exit. An exit the runner only half sees (#1274), a child
 * whose pipes a process it started holds open, or one never reaped, resolves
 * too (watchChildExit).
 */
export async function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  const { code, output } = await spawnCommand(command, args, options, undefined);
  return { code, output };
}

/**
 * `runCommand`, stopped at `timeoutMs` with its whole process group. The
 * result says it timed out and names what was still running. When
 * `startTimeoutAfter` is given, `timeoutMs` starts counting once it resolves
 * for the spawned child, so a stand-in command with a short test limit can
 * finish its setup before the timer runs (#2853).
 */
export function runTimedCommand(
  command: string,
  args: string[],
  options: CommandOptions & { timeoutMs: number; startTimeoutAfter?: (child: ChildProcess) => Promise<void> },
): Promise<TimedResult> {
  return spawnCommand(command, args, options, options.timeoutMs, options.startTimeoutAfter);
}

function spawnCommand(
  command: string,
  args: string[],
  options: CommandOptions,
  timeoutMs: number | undefined,
  startTimeoutAfter?: (child: ChildProcess) => Promise<void>,
): Promise<TimedResult> {
  return new Promise((resolvePromise, reject) => {
    const spawnChild = options.spawnChild ?? spawn;
    const timing = options.timing ?? DEFAULT_COMMAND_TIMING;
    // Its own process group, so what it starts and leaves running can be found and ended.
    const child = spawnChild(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const outputSockets = childOutputSockets(child.pid);
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    let settled = false;
    let limit: ReturnType<typeof setTimeout> | undefined;
    const stopWatching = watchChildExit(child, command, (exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      const hasLeftovers = exit.leftovers.length > 0 && child.pid !== undefined;
      if (hasLeftovers) void endGroup(child.pid ?? 0, timing.leftoverTermMs);
      // Without `close`, output can go missing: say whether the kernel still holds it (#1797).
      const whereOutputWent = isExitWithoutClose(exit.source) ? describeOutputSockets(command, outputSockets) : '';
      resolvePromise({ code: exit.code, output: `${output}${exit.note}${whereOutputWent}`, timedOut: false });
    }, timing.exit);
    const armTimeout = (ms: number) => {
      if (settled) return;
      limit = setTimeout(() => {
        if (settled) return;
        settled = true;
        stopWatching();
        const group = child.pid ?? 0;
        // Read before the stop ends them: what the command was still running.
        const running = group === 0 ? '(unknown)' : describeGroupProcesses(group);
        const note = `\n[runner] ${command} stopped after ${ms / 1000} s; processes in its group:\n${running}\n`;
        if (group !== 0) void endGroup(group, timing.leftoverTermMs);
        resolvePromise({ code: null, output: `${output}${note}`, timedOut: true });
      }, ms);
    };
    if (timeoutMs !== undefined) {
      if (startTimeoutAfter !== undefined) {
        void startTimeoutAfter(child).then(() => armTimeout(timeoutMs), () => armTimeout(timeoutMs));
      } else {
        armTimeout(timeoutMs);
      }
    }
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
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
      if (pins[name]) {
        dependencies[name] = pins[name];
      } else if (PUBLISHED_PACKAGE_NAMES.has(name)) {
        throw new Error(
          `missing packed package ${name} in tarball set (run bash scripts/pack-packages.sh to pack all workspace packages)`,
        );
      }
    }
  }
  manifest.overrides = { ...(manifest.overrides as object | undefined), ...pins };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * How long npm waits on one registry request before it fails it. npm's default
 * is 5 minutes, longer than an install gets here. With this, a stalled request
 * at least ends its wait and shows in npm's debug log; npm retries it twice
 * with backoff, so a request that stalls every time can still outlast an
 * attempt (#1476).
 */
const FETCH_TIMEOUT_MS = 60_000;

const QUIET_NPM_FLAGS = ['--no-audit', '--no-fund', '--loglevel=error', '--progress=false', '--update-notifier=false'];

/**
 * `npm install` as the runner runs it: quiet, with the shared cache. Offline
 * first by default; `online` revalidates the cached package listings. With
 * `logsDir`, npm writes its debug log there, so a hang can be read back.
 */
export function npmInstallArgs(npmCache: string, metadata: 'offline' | 'online' = 'offline', logsDir?: string): string[] {
  const logs = logsDir ? [`--logs-dir=${logsDir}`] : [];
  return ['install', ...QUIET_NPM_FLAGS, `--fetch-timeout=${FETCH_TIMEOUT_MS}`, `--prefer-${metadata}`, '--cache', npmCache, ...logs];
}

/**
 * `npm install` with no registry: `--offline`, an npm cache of its own that
 * starts empty, and a registry nothing listens on, so a request npm should
 * not make fails at once instead of waiting. The dependency store runs it to
 * install a run's Pyric tarballs into a tree it already holds.
 */
export function npmOfflineInstallArgs(npmCache: string, registry: string): string[] {
  return ['install', ...QUIET_NPM_FLAGS, '--offline', `--registry=${registry}`, '--cache', npmCache];
}

/** npm's codes for a version range the cached package listing has no match for. */
const STALE_METADATA = /\bcode (ETARGET|ENOVERSIONS)\b/;

/** npm's codes and transport messages for a dropped or unavailable registry connection. */
const TRANSIENT_NETWORK_CODE = /\b(?:code|errno) (?:ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ERR_SOCKET_TIMEOUT|EAI_AGAIN|ECONNREFUSED|EPIPE|E500|E502|E503|E504)\b/;
const TRANSIENT_NETWORK_MESSAGE = /\b(?:socket hang up|Client network socket disconnected|network socket disconnected|ECONNRESET|ESOCKETTIMEDOUT|ERR_SOCKET_TIMEOUT|EAI_AGAIN)\b/;

const DEFAULT_NETWORK_RETRY_DELAY_MS = 1_000;

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

/**
 * Whether a failed install was interrupted by a transient registry or socket
 * error (such as ECONNRESET or 503). Timed-out installs are not matched here
 * because their caller owns timeout retries, and bad dependencies (E404,
 * ETARGET, ERESOLVE) are never matched.
 */
export function isTransientNetworkFailure(result: CommandResult & { timedOut?: boolean }): boolean {
  if (result.timedOut === true) return false;
  const hasNonZeroExit = result.code !== 0 && result.code !== null;
  if (!hasNonZeroExit) return false;
  return TRANSIENT_NETWORK_CODE.test(result.output) || TRANSIENT_NETWORK_MESSAGE.test(result.output);
}

interface NpmInstallOptions {
  /** Pause before retrying a transient network failure; tests pass 0. */
  networkRetryDelayMs?: number;
  /** Gets one `[runner]` line when an install retries (#1485); `console.log` by default. */
  report?: (line: string) => void;
}

interface NetworkRetryBudget {
  remaining: number;
}

function tenthedSecondsSince(started: number): string {
  return ((performance.now() - started) / 1000).toFixed(1);
}

async function runWithNetworkRetry<R extends CommandResult & { timedOut?: boolean }>(
  args: string[],
  run: (args: string[]) => Promise<R>,
  delayMs: number,
  budget: NetworkRetryBudget,
  report: (line: string) => void,
): Promise<R> {
  const attemptStarted = performance.now();
  const first = await run(args);
  const canRetry = budget.remaining > 0 && isTransientNetworkFailure(first);
  if (!canRetry) return first;
  budget.remaining -= 1;
  report(`[runner] infrastructure retry: retried npm install after transient network error (exit ${first.code}), ${tenthedSecondsSince(attemptStarted)} s`);
  const note = '\n[runner] infrastructure retry: npm install hit a transient network error; retrying once\n';
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const second = await run(args);
  return { ...second, output: `${first.output}${note}${second.output}` };
}

function withRetryPolicy<R extends CommandResult & { timedOut?: boolean }>(result: R): R {
  if (result.code === 0) return result;
  return { ...result, retryable: result.timedOut === true };
}

/**
 * Run `npm install` offline first, then once more with `--prefer-online` when
 * stale metadata failed it, sharing one bounded retry across both phases for
 * transient network errors. A non-timeout failure is marked `retryable: false`
 * so callers do not stack a second retry on top of this one.
 */
export async function npmInstall<R extends CommandResult & { timedOut?: boolean }>(
  npmCache: string,
  run: (args: string[]) => Promise<R>,
  logsDir?: string,
  options: NpmInstallOptions = {},
): Promise<R> {
  const delayMs = options.networkRetryDelayMs ?? DEFAULT_NETWORK_RETRY_DELAY_MS;
  const report = options.report ?? ((line: string) => console.log(line));
  const budget: NetworkRetryBudget = { remaining: 1 };
  const offlineStarted = performance.now();
  const first = await runWithNetworkRetry(npmInstallArgs(npmCache, 'offline', logsDir), run, delayMs, budget, report);
  if (!shouldRetryOnline(first)) return withRetryPolicy(first);
  report(`[runner] retried npm install with --prefer-online after stale cached metadata (exit ${first.code}), ${tenthedSecondsSince(offlineStarted)} s`);
  const note = '\n[runner] npm install failed on stale cached metadata; retrying once with --prefer-online\n';
  const second = await runWithNetworkRetry(npmInstallArgs(npmCache, 'online', logsDir), run, delayMs, budget, report);
  return withRetryPolicy({ ...second, output: `${first.output}${note}${second.output}` });
}

/**
 * How long one nested `npm install` (`app.installProject`) warm attempt gets
 * before the runner calls it hung (#1476, #2137). Measured on a 4-thread host,
 * the chat template took 65.3 s warm (`--no-audit`), 75.2 s warm (`--audit`),
 * 83.3 s cold (`--no-audit`), and 107.9 s cold (`--audit`); under 4-way CI
 * shard concurrency on a slow registry (run 42105313959 attempt 1), legitimate
 * warms took 142.6 to 157.5 s while 110 s killed `my-chat` mid-extraction.
 * 180 s lets slow-registry warms finish on attempt 1 and gives `--fetch-timeout`
 * (60 s) two stalled-request timeouts in npm's debug log before stopping.
 */
export const NESTED_INSTALL_ATTEMPT_MS = 180_000;

/**
 * Default scenario limit for apps that declare a nested install (`NESTED_PROJECTS`
 * in `nested-projects.ts`): two hung 180 s warm attempts plus up to 15 s each
 * to stop and clean up (390 s) still leave 60 s for the scenario's own steps
 * (26 to 39 s measured on the chat scenarios), so a double hang settles inside
 * `installProject` with both npm debug logs instead of hitting the app cap.
 */
export const NESTED_SCENARIO_TIMEOUT_MS = 450_000;

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
  options: { what: string; reset: () => Promise<void>; report: (line: string) => void; shouldRetry?: () => boolean },
): Promise<TimedResult> {
  const started = performance.now();
  const first = await attempt();
  if (!first.timedOut) {
    options.report(`[runner] ${options.what} ${outcome(first)} in ${secondsSince(started)} s, 1 attempt`);
    return first;
  }
  if (options.shouldRetry && !options.shouldRetry()) {
    options.report(`[runner] ${options.what} timed out in ${secondsSince(started)} s, 1 attempt (app closed before retry)`);
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
