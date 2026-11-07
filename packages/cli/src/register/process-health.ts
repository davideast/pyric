/**
 * A registered process says what it is on its own HTTP servers (#2304 G-4).
 *
 * The Vite plugin checks each `server.proxy` target with `GET /__pyric/health`
 * and the `PROCESS_HEALTH_HEADER` request header, so it can tell a live page
 * proxied to a sandbox backend, or the reverse. Wrapping `emit` answers that
 * request before any listener runs, whichever server it is, and passes every
 * other request to the app untouched. The plain health path, without the
 * header, still reaches the app, because a `withPyric` rewrite forwards it to
 * the sandbox host and the chip reads the host's answer there.
 *
 * Only a client on this machine gets an answer, and `PYRIC_PROCESS_HEALTH=off`
 * leaves the path to the app.
 */
import http from 'node:http';
import https from 'node:https';
import { isLoopbackAddress } from '../serve/peer.js';

export const PROCESS_HEALTH_PATH = '/__pyric/health';
/** The request header that asks for this process's health rather than the app's. */
export const PROCESS_HEALTH_HEADER = 'x-pyric-process-health';

const INSTALLED = Symbol.for('pyric.register.processHealth');

/** What the process answers. */
export interface ProcessHealth {
  readonly mode: 'sandbox' | 'live';
  readonly instanceId?: string;
  readonly projectId?: string;
  /** The sandbox host this process's Firebase calls reach. */
  readonly host?: string;
  /** Live mode: the Google and Firebase hosts this process called that no live row observed. */
  readonly unobserved?: readonly string[];
  /** Live mode: the firebase-admin subpaths no row serves that this process loaded. */
  readonly unobservedAdmin?: readonly string[];
}

interface HealthRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

type Emit = (event: string | symbol, ...args: unknown[]) => boolean;

function requestPath(url: string | undefined): string {
  return (url ?? '').split('?', 1)[0] ?? '';
}

function asksForProcessHealth(req: HealthRequest): boolean {
  const isHealthGet = req.method === 'GET' && requestPath(req.url) === PROCESS_HEALTH_PATH;
  const asks = req.headers?.[PROCESS_HEALTH_HEADER] !== undefined;
  return isHealthGet && asks && isLoopbackAddress(req.socket?.remoteAddress);
}

function answer(res: http.ServerResponse, health: ProcessHealth): void {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ pyricProcess: health }));
}

function wrapEmit(prototype: { emit: Emit }, health: () => ProcessHealth): void {
  const original = prototype.emit;
  prototype.emit = function emit(this: unknown, event, ...args) {
    const isRequest = event === 'request';
    if (isRequest && asksForProcessHealth(args[0] as HealthRequest)) {
      answer(args[1] as http.ServerResponse, health());
      return true;
    }
    return original.call(this, event, ...args);
  };
}

/** The sandbox host in `PYRIC_SANDBOX=remote:<url>`, or undefined for another value. */
export function sandboxHost(activator: string | undefined): string | undefined {
  const prefix = 'remote:';
  const isRemote = activator?.startsWith(prefix) === true;
  return isRemote ? activator?.slice(prefix.length) : undefined;
}

/**
 * Answers the process health on every HTTP server in this process. `health`
 * is read on each request, so a value learned after the hooks go in shows.
 * Installs once per process, and not at all under `PYRIC_PROCESS_HEALTH=off`.
 */
export function installProcessHealth(health: () => ProcessHealth): void {
  if (process.env.PYRIC_PROCESS_HEALTH === 'off') return;
  const state = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (state[INSTALLED] === true) return;
  state[INSTALLED] = true;
  wrapEmit(http.Server.prototype as unknown as { emit: Emit }, health);
  wrapEmit(https.Server.prototype as unknown as { emit: Emit }, health);
}
