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

/** Every host maps to "not found" except loopback. */
export const HOST_RESOLVER_RULES = 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1';

/** The environment variable a builder reads the endpoint from. */
export const BROWSER_WS_ENV = 'PYRIC_BUILDER_BROWSER_WS';

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

/** Starts the harness browser in a Node child and returns its endpoint. Runs under Bun or Node. */
export async function startBrowserServer(options: BrowserServerOptions): Promise<BrowserServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  const child = spawn('node', [fileURLToPath(import.meta.url), '--net-log', options.netLogPath], {
    env: browserServerEnvironment(options.home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const wsEndpoint = await endpointFrom(child, log);
  const exited = exitOf(child);
  return {
    wsEndpoint,
    async stop() {
      child.stdin?.end();
      const stopped = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS))]);
      if (!stopped) {
        child.kill('SIGKILL');
        await exited;
        log('[browser server] did not stop in time and was killed; its NetLog may be cut short');
      }
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
