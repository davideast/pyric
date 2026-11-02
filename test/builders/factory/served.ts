/**
 * Keeps the tailnet address on the last good commit. After each check:
 * a failing hour leaves the served copy alone; a passing hour records its
 * commit in `last-good.json` and, when the commit is new or nothing serves,
 * stops the served process, checks the commit out in `<runDir>/served/app`,
 * and starts `served-process.ts` again, detached, on the fixed port.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppPaths } from './app-paths.ts';
import { prepareCheckout } from './app-setup.ts';
import { readLastGood, serveAction, writeLastGood, type ServeAction } from './last-good.ts';
import type { SandboxOpener } from './sandbox.ts';
import { DEFAULT_SERVED_PORT, servedStateFile, servedStateSchema, type ServedState } from './served-process.ts';
import { ensureServed, tailnetHost, tailnetUrl } from './tailnet.ts';
import { npmCacheDir } from '../app-install.ts';
import { playwrightBrowsersPath } from '../browser-server.ts';

const SERVED_PROCESS = fileURLToPath(new URL('./served-process.ts', import.meta.url));
const STOP_WAIT_MS = 60_000;
const START_WAIT_MS = 10 * 60_000;
const POLL_MS = 500;

export function servedPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PYRIC_FACTORY_SERVED_PORT ?? DEFAULT_SERVED_PORT);
}

export function readServedState(paths: AppPaths): ServedState | undefined {
  const file = servedStateFile(paths);
  if (!existsSync(file)) return undefined;
  return servedStateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isServing(paths: AppPaths): boolean {
  const state = readServedState(paths);
  return state !== undefined && state.status === 'ready' && isAlive(state.pid);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) return false;
    await pause(POLL_MS);
  }
  return true;
}

export async function stopServed(paths: AppPaths): Promise<void> {
  const state = readServedState(paths);
  if (state === undefined || !isAlive(state.pid)) return;
  process.kill(state.pid, 'SIGTERM');
  const stopped = await waitUntil(() => !isAlive(state.pid), STOP_WAIT_MS);
  if (!stopped) process.kill(state.pid, 'SIGKILL');
}

/**
 * The detached process's environment: its own HOME, and the host paths the
 * sandbox binds, read here from the harness's HOME before that one replaces it.
 */
function servedEnvironment(paths: AppPaths): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: paths.served.home,
    LANG: process.env.LANG ?? 'C.UTF-8',
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
    PYRIC_APPS_NPM_CACHE: npmCacheDir(),
  };
}

async function startServed(paths: AppPaths, commit: string, port: number): Promise<ServedState> {
  mkdirSync(paths.served.logs, { recursive: true });
  const log = openSync(join(paths.served.logs, 'served-process.log'), 'a');
  const child = spawn(process.execPath, [SERVED_PROCESS, '--run-dir', paths.runDir, '--commit', commit, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', log, log],
    env: servedEnvironment(paths),
  });
  closeSync(log);
  child.unref();
  const pid = child.pid ?? -1;
  const settled = () => {
    const state = readServedState(paths);
    const isOurs = state?.pid === pid && state.status !== 'starting';
    return isOurs || !isAlive(pid);
  };
  await waitUntil(settled, START_WAIT_MS);
  const state = readServedState(paths);
  if (state === undefined || state.pid !== pid) throw new Error(`the served process (pid ${pid}) wrote no state; see ${join(paths.served.logs, 'served-process.log')}`);
  return state;
}

export interface ServeOutcome {
  action: ServeAction;
  /** What happened, for the check's summary. */
  note: string;
  /** The tailnet address of the last good version, once one exists. */
  url?: string;
}

export interface ServeInput {
  paths: AppPaths;
  passed: boolean;
  commit: string;
  hour: number;
  openSandbox: SandboxOpener;
  say: (line: string) => void;
}

/** Serves `commit` when the check passed and it is new, or when nothing serves. */
export async function serveLastGood(input: ServeInput): Promise<ServeOutcome> {
  const { paths } = input;
  const previous = readLastGood(paths.lastGood);
  const port = servedPort();
  const action = serveAction({ previous, passed: input.passed, commit: input.commit, serving: isServing(paths) });
  const host = tailnetHost();
  const hasServed = previous !== undefined || input.passed;
  const url = hasServed && host !== undefined ? tailnetUrl(port, host) : undefined;
  if (input.passed) writeLastGood(paths.lastGood, { commit: input.commit, hour: input.hour, at: new Date().toISOString() });
  if (action === 'leave') return { action, note: input.passed ? 'the served copy already shows this commit' : 'the served copy stays on the last good commit', ...(url === undefined ? {} : { url }) };
  await stopServed(paths);
  await prepareCheckout(paths, paths.served, input.commit, { openSandbox: input.openSandbox, withRoot: false, say: input.say });
  const state = await startServed(paths, input.commit, port);
  if (state.status !== 'ready') return { action, note: `the served copy failed to start: ${state.error ?? 'no reason given'}` };
  const tailnet = ensureServed([port, port + 1]);
  return { action, note: `serving ${input.commit.slice(0, 12)} on 127.0.0.1:${port}; ${tailnet.join('; ')}`, ...(url === undefined ? {} : { url }) };
}
