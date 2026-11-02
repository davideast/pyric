/**
 * The host's half of the way between sandboxes (`socket-bridge.ts` is the
 * inside half). Studio's sandbox listens on Unix sockets in its root; the
 * host reaches them through `/proc/<pid>/root/...`, so the path resolves
 * inside that sandbox's own file system: a socket file Studio's code
 * replaced with a link to one of the host's sockets leads nowhere. The host
 * then listens on a port of its loopback (the served copy), or on a Unix
 * socket in the walk sandbox's root (the walks), and pipes each connection
 * through.
 *
 * A socket's path must fit in 108 bytes, so each is reached through a short
 * link in a fresh directory under /tmp, which is kept.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EgressNamespace } from '../namespace.ts';
import { trackGroup } from './exec.ts';
import { pipeBoth } from './socket-bridge.ts';

const SOCKET_BRIDGE = fileURLToPath(new URL('./socket-bridge.ts', import.meta.url));
const SOCKET_WAIT_MS = 15_000;

/** A short path to `target`: a link in a fresh directory under /tmp. */
export function shortLink(target: string): string {
  const link = join(mkdtempSync('/tmp/pf-'), 'd');
  symlinkSync(target, link);
  return link;
}

/** A short host path that resolves `dir` inside the sandbox whose first process is `pid`. */
export function insideSandbox(pid: number, dir: string): string {
  return shortLink(`/proc/${pid}/root${dir}`);
}

/** Starts the inside half in `cwd` of the sandbox; it ends with the sandbox, the signal or this process. */
export function startInsideBridge(namespace: EgressNamespace, args: readonly string[], cwd: string, signal?: AbortSignal): ChildProcess {
  const entered = namespace.enter('node', [SOCKET_BRIDGE, ...args], cwd);
  const child = spawn(entered.command, entered.args, { stdio: 'ignore', env: { PATH: process.env.PATH ?? '' }, detached: true });
  trackGroup(child, signal);
  return child;
}

export async function waitForSocket(path: string, ms: number = SOCKET_WAIT_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`${path} did not appear within ${ms / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function listen(server: Server, start: (done: () => void) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    start(() => resolve(server));
  });
}

/** Listens on `port` of the host's loopback and pipes each connection to `socket`. */
export function relayPortToSocket(port: number, socket: string): Promise<Server> {
  const server = createServer((client) => pipeBoth(client, connect(socket)));
  return listen(server, (done) => server.listen(port, '127.0.0.1', done));
}

/** Listens on the Unix socket `listenPath` and pipes each connection to `socket`. */
export function relaySocketToSocket(listenPath: string, socket: string): Promise<Server> {
  const server = createServer((client) => pipeBoth(client, connect(socket)));
  return listen(server, (done) => server.listen(listenPath, done));
}
