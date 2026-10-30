/**
 * The model channel: the one way out of a builder run's sandbox, to the
 * model API alone. A builder is `claude -p`, which runs inside the sandbox
 * with every tool it starts, and the sandbox has only loopback, so the model
 * API needs a path of its own. Two halves:
 *
 * - the forwarder, in the harness, outside the sandbox: listens on a Unix
 *   socket in the run directory, reads one HTTP `CONNECT host:port` per
 *   connection, and tunnels it only when the target is the model API
 *   (`api.anthropic.com:443`). Anything else gets `403` and is never dialed.
 *   Each CONNECT, tunneled or refused, is a line of the run's network record.
 * - the bridge, inside the sandbox: listens on 127.0.0.1 and pipes each
 *   connection to that socket. The builder reaches it through `HTTPS_PROXY`.
 *
 * The decision is made outside the sandbox, where nothing a builder runs can
 * change it. TLS runs end to end between the client and the model API; the
 * forwarder sees only the CONNECT line.
 */
import { appendFileSync } from 'node:fs';
import net from 'node:net';
import { classifyHost, type HostClass } from './recorder/google-hosts.ts';

export interface ModelTarget {
  host: string;
  port: number;
}

/** The only target the forwarder tunnels to. */
export const MODEL_API: ModelTarget = { host: 'api.anthropic.com', port: 443 };

/** One CONNECT the forwarder read, as a line of `network.jsonl`. */
export interface ModelChannelEvent extends HostClass {
  time: string;
  layer: 'model-channel';
  kind: 'connect';
  via: 'forwarder';
  port: number;
  action: 'allowed' | 'refused';
}

/** The most a CONNECT head may hold before the forwarder gives up on it. */
const MAX_HEAD_BYTES = 8192;
const HEAD_END = '\r\n\r\n';

/** The target of a `CONNECT host:port HTTP/1.x` head, or undefined for anything else. */
export function connectTarget(head: string): ModelTarget | undefined {
  const requestLine = head.split('\r\n')[0] ?? '';
  const match = /^CONNECT ([A-Za-z0-9.-]+):(\d{1,5}) HTTP\/1\.[01]$/.exec(requestLine);
  if (match === null) return undefined;
  return { host: (match[1] ?? '').toLowerCase(), port: Number(match[2]) };
}

export function isAllowedTarget(target: ModelTarget | undefined, allowed: ModelTarget): boolean {
  return target !== undefined && target.host === allowed.host.toLowerCase() && target.port === allowed.port;
}

export function channelEvent(target: ModelTarget, action: ModelChannelEvent['action'], time: Date = new Date()): ModelChannelEvent {
  return { time: time.toISOString(), layer: 'model-channel', kind: 'connect', via: 'forwarder', ...classifyHost(target.host), port: target.port, action };
}

export interface ForwarderOptions {
  socketPath: string;
  networkLog: string;
  /** What a CONNECT may name. */
  allowed: ModelTarget;
  /** Where an allowed CONNECT is dialed; the allowed target itself unless a test points it at a local server. */
  upstream?: ModelTarget;
}

export interface Listening {
  close(): Promise<void>;
}

/** Reads the CONNECT head, then hands the socket and any bytes after the head on. */
function readHead(socket: net.Socket, onHead: (head: string, rest: Buffer) => void): void {
  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf(HEAD_END);
    const headEnded = end !== -1;
    const headTooLong = !headEnded && buffered.length > MAX_HEAD_BYTES;
    if (headTooLong) {
      socket.destroy();
      return;
    }
    if (!headEnded) return;
    socket.off('data', onData);
    onHead(buffered.subarray(0, end).toString('latin1'), buffered.subarray(end + HEAD_END.length));
  };
  socket.on('data', onData);
  socket.on('error', () => socket.destroy());
}

function tunnel(client: net.Socket, upstream: ModelTarget, rest: Buffer): void {
  const remote = net.connect(upstream.port, upstream.host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (rest.length > 0) remote.write(rest);
    client.pipe(remote).pipe(client);
  });
  remote.on('error', () => {
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  client.on('close', () => remote.destroy());
}

/** Starts the forwarder on `socketPath`. */
export function startModelForwarder(options: ForwarderOptions): Promise<Listening> {
  const server = net.createServer((client) => {
    readHead(client, (head, rest) => {
      const target = connectTarget(head);
      const allowed = isAllowedTarget(target, options.allowed);
      if (target !== undefined) appendFileSync(options.networkLog, `${JSON.stringify(channelEvent(target, allowed ? 'allowed' : 'refused'))}\n`);
      if (allowed) tunnel(client, options.upstream ?? options.allowed, rest);
      else client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
  });
  return listen(server, (ready) => server.listen(options.socketPath, ready));
}

/** Starts the bridge on a free loopback port, piping each connection to `socketPath`. */
export async function startBridge(socketPath: string): Promise<Listening & { port: number }> {
  const server = net.createServer((client) => {
    const forwarder = net.connect(socketPath);
    forwarder.on('error', () => client.destroy());
    client.on('error', () => forwarder.destroy());
    client.pipe(forwarder).pipe(client);
  });
  const listening = await listen(server, (ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the bridge has no port');
  return { ...listening, port: address.port };
}

function listen(server: net.Server, start: (ready: () => void) => void): Promise<Listening> {
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    start(() => resolve({
      close: () => new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
    }));
  });
}

/** What a builder's environment needs to reach the model API through the bridge. */
export function proxyEnvironment(bridgePort: number): Record<string, string> {
  const proxy = `http://127.0.0.1:${bridgePort}`;
  return { HTTPS_PROXY: proxy, https_proxy: proxy, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
}
