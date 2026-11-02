/**
 * Keeps the served copy on the last good commit. After each check: a failing
 * hour leaves it alone; a passing hour records its commit in
 * `last-good.json` and, when the commit is new or nothing serves, stops the
 * served process, exports the commit into a fresh tree of `<run>.work/`, and
 * starts `served-process.ts` there, detached, on the fixed port. Only that
 * port goes on the private network (`tailnet.ts`); Pyric's WebSocket port
 * stays on this machine's loopback.
 *
 * Before it signals the served process, the harness checks the pid in
 * `served.json` against /proc: its command line must be `served-process.ts`
 * for this run, and its start time the one recorded, so a reused pid is never
 * signalled. A URL is reported only once that process says it is ready.
 * When the run ends, `stopRunServing` stops the process and removes the
 * private-network entries this run added. The served process also stops
 * itself, and removes those entries, when the process that started it is
 * gone or the run's deadline passes (`served-owner.ts`), so a supervisor
 * that dies before its run end doesn't leave it serving.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCacheDir } from '../app-install.ts';
import { playwrightBrowsersPath } from '../browser-server.ts';
import { startTimeOf } from '../namespace.ts';
import { appPaths, type AppPaths } from './app-paths.ts';
import type { AppRecord } from './app-setup.ts';
import { appendFile } from './host-files.ts';
import { readLastGood, serveAction, writeLastGood, type ServeAction } from './last-good.ts';
import { optional } from './optional.ts';
import type { SandboxOpener } from './sandbox.ts';
import { DEFAULT_SERVED_PORT, servedStateFile, servedStateSchema, type ServedState } from './served-process.ts';
import { hasRun, readRun, runPaths } from './run-dir.ts';
import { recordEntries, removeRecordedEntries } from './served-entries.ts';
import { ownerArgs, type Owner } from './served-owner.ts';
import { readJson } from './state-files.ts';
import { bunCacheDir } from './studio-install.ts';
import { ensureServed, tailnetHost, tailnetUrl, tailscaleFrom } from './tailnet.ts';
import { exportTree } from './tree.ts';

export const SERVED_PROCESS = fileURLToPath(new URL('./served-process.ts', import.meta.url));
const STOP_WAIT_MS = 60_000;
const START_WAIT_MS = 15 * 60_000;
const POLL_MS = 500;

export class ServedPortInvalid extends Error {}

export function servedPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.PYRIC_FACTORY_SERVED_PORT ?? DEFAULT_SERVED_PORT);
  const isValid = Number.isInteger(port) && port >= 1024 && port <= 65534;
  if (!isValid) throw new ServedPortInvalid(`PYRIC_FACTORY_SERVED_PORT must be a port from 1024 to 65534, not ${env.PYRIC_FACTORY_SERVED_PORT}`);
  return port;
}

export function readServedState(paths: AppPaths): ServedState | undefined {
  return readJson(servedStateFile(paths), servedStateSchema);
}

function commandLineOf(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  } catch {
    return [];
  }
}

/** Whether `state`'s pid is this run's served process: its command line and its start time. */
export function isServedProcess(state: ServedState, runDir: string): boolean {
  const args = commandLineOf(state.pid);
  const runDirAt = args.indexOf('--run-dir');
  const isOurs = args.includes(SERVED_PROCESS) && runDirAt !== -1 && args[runDirAt + 1] === runDir && state.runDir === runDir;
  return isOurs && state.startTime !== '' && startTimeOf(state.pid) === state.startTime;
}

/** The served process's state, when its pid is verified. */
function verifiedState(paths: AppPaths): ServedState | undefined {
  const state = readServedState(paths);
  if (state === undefined || !isServedProcess(state, paths.runDir)) return undefined;
  return state;
}

export function isServing(paths: AppPaths): boolean {
  return verifiedState(paths)?.status === 'ready';
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end || signal?.aborted === true) return false;
    await pause(POLL_MS);
  }
  return true;
}

/** Stops the served process, once its pid is verified; a pid that isn't it is never signalled. */
export async function stopServed(paths: AppPaths): Promise<void> {
  const state = verifiedState(paths);
  if (state === undefined) return;
  const isGone = () => !isServedProcess(state, paths.runDir);
  process.kill(state.pid, 'SIGTERM');
  const stopped = await waitUntil(isGone, STOP_WAIT_MS);
  if (!stopped && !isGone()) process.kill(state.pid, 'SIGKILL');
}

/**
 * The detached process's environment: the host paths the sandbox binds,
 * read here from the harness's HOME, which the served process doesn't get.
 */
function servedEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH ?? '',
    HOME: '/nonexistent',
    LANG: env.LANG ?? 'C.UTF-8',
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
    PYRIC_APPS_NPM_CACHE: npmCacheDir(),
    BUN_INSTALL_CACHE_DIR: bunCacheDir(),
    ...optional('PYRIC_FACTORY_TAILSCALE', env.PYRIC_FACTORY_TAILSCALE),
    ...optional('PYRIC_FACTORY_TAILNET_HOST', env.PYRIC_FACTORY_TAILNET_HOST),
  };
}

/** This process, which the served copy outlives only until the run's deadline. */
function currentOwner(runDir: string): Owner {
  const owner: Owner = { pid: process.pid, startTime: startTimeOf(process.pid) ?? '' };
  const run = runPaths(runDir);
  if (hasRun(run)) owner.deadline = Date.parse(readRun(run).deadline);
  return owner;
}

async function startServed(paths: AppPaths, commit: string, port: number, signal?: AbortSignal): Promise<ServedState | undefined> {
  const tree = exportTree(paths, commit, 'served');
  const log = openSync(join(paths.host, 'served-process.log'), 'a');
  const args = [SERVED_PROCESS, '--run-dir', paths.runDir, '--commit', commit, '--root', tree.root, '--port', String(port), ...ownerArgs(currentOwner(paths.runDir))];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: servedEnvironment() });
  closeSync(log);
  child.unref();
  const pid = child.pid ?? -1;
  const settled = () => {
    const state = readServedState(paths);
    const isOurs = state?.pid === pid && state.status !== 'starting';
    return isOurs || startTimeOf(pid) === null;
  };
  await waitUntil(settled, START_WAIT_MS, signal);
  const state = readServedState(paths);
  return state?.pid === pid ? state : undefined;
}

export interface ServeOutcome {
  action: ServeAction;
  /** What happened, for the check's summary. */
  note: string;
  /** The private-network address of the last good version, once it is served and ready. */
  url?: string;
  /** The same, on this machine. */
  localUrl?: string;
}

export interface ServeInput {
  paths: AppPaths;
  record: AppRecord;
  passed: boolean;
  commit: string;
  hour: number;
  signal?: AbortSignal;
  openSandbox?: SandboxOpener;
  say: (line: string) => void;
}

/** The addresses of a ready served copy. */
function urlsOf(port: number): Pick<ServeOutcome, 'url' | 'localUrl'> {
  const host = tailnetHost();
  return { localUrl: `http://127.0.0.1:${port}/`, ...optional('url', host === undefined ? undefined : tailnetUrl(port, host)) };
}

function leaveNote(passed: boolean): string {
  if (passed) return 'the served copy already shows this commit';
  return 'the served copy stays on the last good commit';
}

/** Serves `commit` when the check passed and it is new, or when nothing serves. */
export async function serveLastGood(input: ServeInput): Promise<ServeOutcome> {
  const { paths } = input;
  const previous = readLastGood(paths.lastGood);
  const port = servedPort();
  const serving = isServing(paths);
  const action = serveAction({ previous, passed: input.passed, commit: input.commit, serving });
  if (input.passed) writeLastGood(paths.lastGood, { commit: input.commit, hour: input.hour, at: new Date().toISOString() });
  if (action === 'leave') return { action, note: leaveNote(input.passed), ...(serving ? urlsOf(port) : {}) };
  await stopServed(paths);
  input.say(`serving ${input.commit.slice(0, 12)} on 127.0.0.1:${port}`);
  const state = await startServed(paths, input.commit, port, input.signal);
  const isReady = state?.status === 'ready' && isServedProcess(state, paths.runDir);
  if (!isReady) return { action, note: `the served copy failed to start: ${state?.error ?? 'it wrote no ready state'}; see ${join(paths.host, 'served-process.log')}` };
  const published = ensureServed([port], tailscaleFrom());
  recordEntries(paths, published.added);
  return { action, note: `serving ${input.commit.slice(0, 12)} on 127.0.0.1:${port}; ${published.lines.join('; ')}`, ...urlsOf(port) };
}

/** Stops this run's served copy and removes the private-network entries it added. Runs when the run ends. */
export async function stopRunServing(runDir: string, log: (line: string) => void = (line) => console.log(line)): Promise<void> {
  const paths = appPaths(runDir);
  const isSetUp = existsSync(paths.record);
  if (!isSetUp) return;
  await stopServed(paths);
  for (const line of removeRecordedEntries(paths)) log(line);
  appendFile(join(paths.host, 'served-process.log'), `${new Date().toISOString()} the run ended; the served copy is stopped\n`);
}
