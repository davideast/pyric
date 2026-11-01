/**
 * The harness browser: one Playwright Chromium per run, launched as a browser
 * server that a builder reaches with `chromium.connect(wsEndpoint)`.
 *
 * - `--host-resolver-rules` leave only 127.0.0.1 and localhost reachable.
 *   Chromium applies the rules to IP literals too, so 169.254.169.254 and
 *   127.0.0.2 fail like any other host, with ERR_NAME_NOT_RESOLVED, before a
 *   socket opens.
 * - `--log-net-log` records every request, WebSockets and service-worker
 *   fetches included (`recorder/chromium-netlog.ts` reads it).
 *
 * Playwright's browser server and its `connect` work under Node and not under
 * Bun 1.3 (the WebSocket handshake fails), so the server always runs in a
 * Node child: `startBrowserServer` spawns this file with `node`, and the
 * builder's own Playwright script runs under Node too.
 *
 *   node test/builders/browser-server.ts --net-log <file>
 *
 * prints one line, `{"wsEndpoint":"ws://127.0.0.1:…"}`, and closes the browser
 * (which flushes the NetLog) on SIGTERM, SIGINT or when its stdin closes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendBrowserIncomplete } from './recorder/network-record.ts';

/** Every host maps to "not found" except loopback. */
export const HOST_RESOLVER_RULES = 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1';

/** The environment variable a builder reads the endpoint from. */
export const BROWSER_WS_ENV = 'PYRIC_BUILDER_BROWSER_WS';

/**
 * The environment variable naming the Playwright client the server itself
 * runs, so a builder or a repro script connects with the same version:
 * `const { chromium } = await import(process.env.PYRIC_BUILDER_PLAYWRIGHT)`.
 * A run's app installs offline and has no Playwright of its own.
 */
export const PLAYWRIGHT_CLIENT_ENV = 'PYRIC_BUILDER_PLAYWRIGHT';

/**
 * The harness's own `@playwright/test` ES module entry, inside the repo, which
 * the sandbox binds read-only. The ES entry, since a dynamic `import()` of
 * the CommonJS one has no named `chromium`.
 */
export function playwrightClient(): string {
  return fileURLToPath(import.meta.resolve('@playwright/test'));
}

/** Chromium's arguments for one run. */
export function chromiumArgs(netLogPath: string): string[] {
  return [`--log-net-log=${netLogPath}`, `--host-resolver-rules=${HOST_RESOLVER_RULES}`];
}

/** Where Playwright's browsers are, read from the harness's own HOME before a run's scratch HOME replaces it. */
export function playwrightBrowsersPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright');
}

export interface BrowserServerOptions {
  netLogPath: string;
  /** The run's network record: a server killed at stop leaves an `incomplete` marker there. */
  networkLog: string;
  /** The run's scratch HOME. Chromium gets it, and nothing else of the harness's environment besides PATH and the locale. */
  home: string;
  /** Where the server's own output goes. */
  log?: (line: string) => void;
}

export interface BrowserServer {
  wsEndpoint: string;
  /** Closes the browser and waits for the NetLog to be written. */
  stop(): Promise<void>;
}

const STARTUP_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 30_000;

function browserServerEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
  };
  for (const key of ['PATH', 'LANG', 'TMPDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** The endpoint line the server prints once Chromium is up. */
function endpointFrom(child: ChildProcess, log: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`the browser server printed no endpoint within ${STARTUP_TIMEOUT_MS / 1000}s:\n${stdout}`)), STARTUP_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      const line = stdout.split('\n').find((text) => text.startsWith('{"wsEndpoint"'));
      if (line === undefined) return;
      clearTimeout(timer);
      resolve((JSON.parse(line) as { wsEndpoint: string }).wsEndpoint);
    });
    child.stderr?.on('data', (chunk) => log(`[browser server] ${String(chunk).trimEnd()}`));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the browser server exited (code ${code}) before it printed an endpoint:\n${stdout}`));
    });
  });
}

function exitOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

export interface ChildStop {
  /** The run's network record, where a kill leaves its `incomplete` marker. */
  networkLog: string;
  timeoutMs: number;
  log: (line: string) => void;
}

/**
 * Closes the server's stdin and waits for it to exit. One that outlasts
 * `timeoutMs` is killed, and the network record gets an `incomplete` marker,
 * since the NetLog may then end before the browser's last events. Resolves
 * whether it had to kill.
 */
export async function stopBrowserChild(child: ChildProcess, stop: ChildStop): Promise<{ killed: boolean }> {
  const exited = exitOf(child);
  child.stdin?.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), stop.timeoutMs); });
  const stopped = await Promise.race([exited.then(() => true), timedOut]);
  clearTimeout(timer);
  if (stopped) return { killed: false };
  child.kill('SIGKILL');
  await exited;
  const reason = `the browser server did not stop within ${stop.timeoutMs / 1000}s and was killed; its NetLog may be cut short`;
  appendBrowserIncomplete(stop.networkLog, reason);
  stop.log(`[browser server] ${reason}`);
  return { killed: true };
}

/** Starts the harness browser in a Node child and returns its endpoint. Runs under Bun or Node. */
export async function startBrowserServer(options: BrowserServerOptions): Promise<BrowserServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  const child = spawn('node', [fileURLToPath(import.meta.url), '--net-log', options.netLogPath], {
    env: browserServerEnvironment(options.home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const wsEndpoint = await endpointFrom(child, log);
  return {
    wsEndpoint,
    async stop() {
      await stopBrowserChild(child, { networkLog: options.networkLog, timeoutMs: STOP_TIMEOUT_MS, log });
    },
  };
}

// ---------------------------------------------------------------- the Node child

function netLogArgument(argv: readonly string[]): string {
  const index = argv.indexOf('--net-log');
  const path = index === -1 ? undefined : argv[index + 1];
  if (path === undefined) throw new Error('usage: node test/builders/browser-server.ts --net-log <file>');
  return path;
}

/** Runs the browser server until it is told to stop. */
async function serve(netLogPath: string): Promise<void> {
  const { chromium } = await import('@playwright/test');
  const server = await chromium.launchServer({ headless: true, args: chromiumArgs(netLogPath) });
  console.log(JSON.stringify({ wsEndpoint: server.wsEndpoint() }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  process.stdin.once('end', () => void stop());
  process.stdin.resume();
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) await serve(netLogArgument(process.argv));
