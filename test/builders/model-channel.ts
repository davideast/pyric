/**
 * The model channel: the one way out of a builder run's sandbox, to the
 * model API alone, carrying no credential the sandbox could read. A builder
 * is `claude -p`, which runs inside the sandbox with every tool it starts,
 * and the sandbox has only loopback, so the model API needs a path of its
 * own. Two halves:
 *
 * - the bridge, inside the sandbox: listens on 127.0.0.1 and pipes each
 *   connection to a Unix socket in the run directory. claude reaches it as
 *   `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, in plain HTTP, holding
 *   only a placeholder token (`builder-command.ts`).
 * - the forwarder, in the harness, outside the sandbox (`model-forwarder.ts`):
 *   listens on that socket, refuses anything but the Messages API requests
 *   claude needs, puts the real token on the ones it allows, and sends them
 *   to `api.anthropic.com:443` over TLS.
 *
 * Each connection is one line of the run's channel record. Once the sandbox
 * has stopped, `round` appends those lines to the run's `network.jsonl`.
 */
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import type { RequestHead } from './http-head.ts';
import type { RefusalReason } from './model-policy.ts';
import { pathOf } from './model-policy.ts';
import { classifyHost, type HostClass } from './recorder/google-hosts.ts';
import type { MeteredUsage } from './usage-tap.ts';
import type { Tokens } from './usage.ts';

/** How a forwarded request ended when it did not end with the model API's whole response. */
export type ForwardNote = 'upstream-error' | 'client-closed';

export type ChannelOutcome =
  | { action: 'forwarded'; reason: ForwardNote | null; status: number | null; usage: MeteredUsage | undefined; costUsd: number | null }
  | { action: 'refused'; reason: RefusalReason; status: number | null; usage: undefined; costUsd: null };

/** One connection to the forwarder, as a line of `network.jsonl`. */
export interface ModelChannelEvent extends HostClass {
  time: string;
  layer: 'model-channel';
  kind: 'request';
  via: 'forwarder';
  /** The first line the client sent, shortened and escaped; empty when it sent nothing. */
  requestLine: string;
  method: string | null;
  path: string | null;
  action: ChannelOutcome['action'];
  reason: RefusalReason | ForwardNote | null;
  /** The status the builder got; null when the connection closed first. */
  status: number | null;
  /** The model the response named, and the usage and cost the forwarder metered from it. */
  model: string | null;
  tokens: Tokens | null;
  costUsd: number | null;
}

export function channelEvent(host: string, requestLine: string, head: RequestHead | undefined, outcome: ChannelOutcome, time: Date = new Date()): ModelChannelEvent {
  return {
    time: time.toISOString(),
    layer: 'model-channel',
    kind: 'request',
    via: 'forwarder',
    ...classifyHost(host),
    requestLine,
    method: head?.method ?? null,
    path: head === undefined ? null : pathOf(head.target),
    action: outcome.action,
    reason: outcome.reason,
    status: outcome.status,
    model: outcome.usage?.model ?? null,
    tokens: outcome.usage?.tokens ?? null,
    costUsd: outcome.costUsd,
  };
}

/** The forwarder's record of a run, line by line. The forwarder alone writes it. */
export function readChannelRecord(path: string): ModelChannelEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as ModelChannelEvent);
}

/** The metered cost of a run: the sum of its forwarded requests' costs. */
export function meteredCostUsd(events: readonly ModelChannelEvent[]): number {
  return events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0);
}

export interface Listening {
  close(): Promise<void>;
}

/** Starts `server`, tracking its sockets so `close` ends every connection still open. */
export function listen(start: (server: net.Server) => void, onConnection: (socket: net.Socket) => void): Promise<Listening & { server: net.Server }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve({
      server,
      close: () => new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
    }));
    start(server);
  });
}

/** Starts the bridge on a free loopback port, piping each connection to `socketPath`. */
export async function startBridge(socketPath: string): Promise<Listening & { port: number }> {
  const listening = await listen((server) => server.listen(0, '127.0.0.1'), (client) => {
    const forwarder = net.connect(socketPath);
    forwarder.on('error', () => client.destroy());
    client.on('error', () => forwarder.destroy());
    client.pipe(forwarder).pipe(client);
  });
  const address = listening.server.address();
  if (address === null || typeof address === 'string') throw new Error('the bridge has no port');
  return { close: listening.close, port: address.port };
}

/** Where a builder finds the model API: the bridge, in plain HTTP on the sandbox's loopback. */
export function channelEnvironment(bridgePort: number): Record<string, string> {
  return { ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridgePort}` };
}
