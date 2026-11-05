// A local server that plays production Firebase for the real `firebase` web
// SDK: Firestore's Listen and Write streams over WebChannel and the Auth REST
// calls a sign-in makes, each answered from recorded exchanges. It listens on
// 127.0.0.1 only and fails closed: every request it cannot answer from a
// recording is refused and listed in `unmatched`.
//
// A request names the Google host it was meant for either as the first path
// segment (`http://127.0.0.1:<port>/firestore.googleapis.com/...`, how
// `routeFirebaseTo` in seam.ts rewrites it, and the path the Auth SDK's own
// `connectAuthEmulator` builds) or in its Host header. A Firestore stream path
// with no host segment (`/google.firestore.v1.Firestore/Listen/channel`) is the
// one `connectFirestoreEmulator` builds, and is Firestore's.
//
// With `grpc`, the same recordings also answer Firestore's streams over gRPC,
// the Node SDK's transport, from one shared state (`grpc.ts`).
//
// A WebSocket upgrade on `/.ws` is an RTDB connection, the URL
// `connectDatabaseEmulator` builds: its `ns` names the instance, and
// `rtdb.ts` answers it from the same recordings.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { answerAuth, AUTH_HOSTS, parseRestBody } from './auth.ts';
import type { Recording } from './format.ts';
import { ListenStream, ReplayState, WriteStream, type Received, type Unmatched } from './firestore.ts';
import { startGrpcReplay, type GrpcReplay } from './grpc.ts';
import { RtdbConnection } from './rtdb.ts';
import { parseForwardBody, WebChannelSession } from './webchannel.ts';

export const FIRESTORE_HOST = 'firestore.googleapis.com';
export const REPLAYED_HOSTS = [FIRESTORE_HOST, ...AUTH_HOSTS];
/** The first path segment of a Firestore stream an emulator connector names. */
const FIRESTORE_SERVICE = 'google.firestore.v1.Firestore';

export interface ReplayServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** Every request no recording answered, in arrival order. */
  unmatched: Unmatched[];
  /** Every request any client sent, answered or not, in arrival order. */
  received: Received[];
  /** The gRPC streams, when `startReplayServer` was given `grpc`. */
  grpc: GrpcReplay | null;
  close(): Promise<void>;
}

export interface ReplayOptions {
  /** Also answer Firestore over gRPC, with the `@grpc/grpc-js` and protos of the SDK installed in `projectDir`. */
  grpc?: { projectDir: string };
}

/** Where a request was meant to go. */
export interface Route {
  host: string;
  path: string;
  url: URL;
}

/** The Google host and path a request names, or null for one this harness does not replay. */
export function routeOf(request: IncomingMessage): Route | null {
  const url = new URL(request.url ?? '/', 'http://replay.invalid');
  const [, first, ...rest] = url.pathname.split('/');
  if (first && REPLAYED_HOSTS.includes(first)) return { host: first, path: `/${rest.join('/')}`, url };
  if (first === FIRESTORE_SERVICE) return { host: FIRESTORE_HOST, path: url.pathname, url };
  const host = (request.headers.host ?? '').replace(/:\d+$/, '');
  return REPLAYED_HOSTS.includes(host) ? { host, path: url.pathname, url } : null;
}

export async function startReplayServer(recordings: Recording[], options: ReplayOptions = {}): Promise<ReplayServer> {
  const state = new ReplayState(recordings);
  const grpc = options.grpc ? await startGrpcReplay(state, options.grpc.projectDir) : null;
  const sessions = new Map<string, WebChannelSession>();
  const sockets = new Set<WsSocket>();
  const server = createServer((request, response) => {
    void handle(state, sessions, request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(`pyric replay: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void upgrade(state, sockets, request, socket, head).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    unmatched: state.unmatched,
    received: state.received,
    grpc,
    close: async () => {
      grpc?.close();
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      await closeServer(server, sessions);
    },
  };
}

async function closeServer(server: Server, sessions: Map<string, WebChannelSession>): Promise<void> {
  for (const session of sessions.values()) session.terminate();
  sessions.clear();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function handle(state: ReplayState, sessions: Map<string, WebChannelSession>, request: IncomingMessage, response: ServerResponse): Promise<void> {
  allowCrossOrigin(request, response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  const report = REPORTS[request.url ?? ''];
  if (request.method === 'GET' && report) {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(report(state)));
    return;
  }
  const route = routeOf(request);
  const body = await readBody(request);
  if (route?.host === FIRESTORE_HOST) return channel(state, sessions, route, request, response, body);
  if (route) {
    const answer = answerAuth(state, { method: request.method ?? 'GET', host: route.host, path: route.path, body: parseRestBody(body) });
    response.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(answer.body));
    return;
  }
  state.unmatched.push({ rpc: 'http', as: null, request: { method: request.method ?? '', host: request.headers.host ?? '', path: request.url ?? '' } });
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('pyric replay: no recorded host for this request');
}

/** What the server saw, for a caller in another process (`serve.ts`, `process.ts`). */
const REPORTS: Record<string, (state: ReplayState) => unknown> = {
  '/__replay/received': (state) => state.received,
  '/__replay/unmatched': (state) => state.unmatched,
};

const CHANNEL_PATH = /^\/google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel$/;

function channel(state: ReplayState, sessions: Map<string, WebChannelSession>, route: Route, request: IncomingMessage, response: ServerResponse, body: string): void {
  const rpc = CHANNEL_PATH.exec(route.path)?.[1] as 'Listen' | 'Write' | undefined;
  if (!rpc) {
    state.unmatched.push({ rpc: 'http', as: null, request: { method: request.method ?? '', path: route.path } });
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end(`pyric replay: Firestore ${route.path} is not a recorded stream`);
    return;
  }
  const params = route.url.searchParams;
  const sid = params.get('SID');
  const type = params.get('TYPE');
  const isHandshake = request.method === 'POST' && (sid === null || sid === 'null');
  if (isHandshake) return openSession(state, sessions, rpc, response, body);
  const session = sid ? sessions.get(sid) : undefined;
  if (!session || session.isClosed) {
    response.writeHead(400, { 'content-type': 'text/plain' });
    response.end('Unknown SID');
    return;
  }
  if (type === 'terminate') {
    session.terminate();
    sessions.delete(session.sid);
    response.writeHead(200);
    response.end();
    return;
  }
  if (request.method === 'GET') return session.attachBackChannel(request, response, route.url);
  session.receive(parseForwardBody(body));
  session.acknowledge(response, route.url);
}

function openSession(state: ReplayState, sessions: Map<string, WebChannelSession>, rpc: 'Listen' | 'Write', response: ServerResponse, body: string): void {
  const batch = parseForwardBody(body);
  const bearer = /^Bearer (.+)$/.exec(batch.headers.authorization ?? '')?.[1];
  const as = state.tokens.uidOf(bearer);
  const session = new WebChannelSession();
  session.handler = rpc === 'Listen' ? new ListenStream(session, state, as) : new WriteStream(session, state, as);
  sessions.set(session.sid, session);
  session.handshake(response);
  session.receive(batch);
}

/** The part of a `ws` socket an RTDB connection uses. */
interface WsSocket {
  send(text: string): void;
  close(): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'close', listener: () => void): void;
}

interface WsServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, done: (socket: WsSocket) => void): void;
}

let wsServer: Promise<WsServer> | null = null;

/**
 * A `noServer` `ws` server, loaded on the first upgrade. Bun provides `ws`
 * itself; the root workspace does not depend on it, so a `node` process
 * (`serve.ts`) that never opens an RTDB connection never needs it.
 */
function webSockets(): Promise<WsServer> {
  wsServer ??= import('ws').then((ws: { WebSocketServer: new (options: { noServer: true }) => WsServer }) => new ws.WebSocketServer({ noServer: true }));
  return wsServer;
}

const RTDB_PATH = '/.ws';

/** Opens an RTDB connection on `/.ws` for the instance its `ns` names, or refuses the upgrade with a 404. */
async function upgrade(state: ReplayState, sockets: Set<WsSocket>, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://replay.invalid');
  const instance = url.searchParams.get('ns');
  if (url.pathname !== RTDB_PATH || !instance) {
    state.unmatched.push({ rpc: 'http', as: null, request: { method: request.method ?? '', path: request.url ?? '' } });
    socket.end('HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\n\r\npyric replay: no recorded WebSocket at this path\n');
    return;
  }
  const server = await webSockets();
  server.handleUpgrade(request, socket, head, (ws) => {
    sockets.add(ws);
    const connection = new RtdbConnection(ws, state, instance, request.headers.host ?? '');
    ws.on('message', (data) => connection.onFrame(data.toString('utf8')));
    ws.on('close', () => sockets.delete(ws));
    connection.open();
  });
}

function allowCrossOrigin(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (!origin) return;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-credentials', 'true');
  response.setHeader('access-control-allow-headers', request.headers['access-control-request-headers'] ?? '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-expose-headers', 'x-http-session-id');
}

export function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part: string) => { body += part; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
