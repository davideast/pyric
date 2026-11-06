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
//
// With `ai`, a POST to `/v1beta/projects/<project>/models/<model>:<task>`,
// the path the `firebase/ai` SDK builds from a model's `baseUrl`, is AI
// Logic's, answered from the committed observations (`ai.ts`). Its CORS
// preflight is answered like every other.
//
// A Cloud Storage call is `/v0/b/<bucket>/o...`, the path
// `connectStorageEmulator` builds, or the same path under a
// `/firebasestorage.googleapis.com` segment, how the seam rewrites it.
// `storage.ts` answers it from the recordings' `storage` exchanges, and a
// call none answers gets a 400 the SDK does not retry. The CORS answer allows
// the PATCH and DELETE the Storage SDK sends and exposes the
// `X-Goog-Upload-*` headers a resumable upload reads from its XHR.
//
// A Firebase Installations or FCM registrations call, the two APIs
// `firebase/messaging` calls, names its host as the first path segment
// (`/firebaseinstallations.googleapis.com/v1/projects/<p>/installations...`,
// `/fcmregistrations.googleapis.com/v1/projects/<p>/registrations...`, how
// the seam rewrites it) or in its Host header. `messaging.ts` answers it from
// the recordings' `messaging` exchanges, and every path under those hosts
// that none answers gets a 400. Their CORS preflight is answered like every
// other: the allowed headers echo the ones the preflight asks for
// (`x-goog-api-key`, `x-goog-firebase-installations-auth`, `Authorization`,
// `x-firebase-client`), and the allowed methods include DELETE and PATCH.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { aiCallOf, answerAi, type AiReceived } from './ai.ts';
import { answerAuth, AUTH_HOSTS, parseRestBody } from './auth.ts';
import type { Recording } from './format.ts';
import { MESSAGING_HOSTS, MessagingReplay, readMessagingRequest, type MessagingReceived } from './messaging.ts';
import { ListenStream, ReplayState, WriteStream, type Received, type Unmatched } from './firestore.ts';
import { startGrpcReplay, type GrpcReplay } from './grpc.ts';
import { RtdbConnection, RtdbShared, type RtdbLog, type RtdbReceived } from './rtdb.ts';
import { readStorageRequest, STORAGE_HOST, STORAGE_VERSION_SEGMENT, StorageReplay, type StorageReceived } from './storage.ts';
import { parseForwardBody, WebChannelSession } from './webchannel.ts';

export const FIRESTORE_HOST = 'firestore.googleapis.com';
/** The hosts `routeOf` names: Firestore's and Auth's, which the recorder also relays. */
const ROUTED_HOSTS = [FIRESTORE_HOST, ...AUTH_HOSTS];
/** Every Google host this server answers, which the seam routes to it. */
export const REPLAYED_HOSTS = [...ROUTED_HOSTS, STORAGE_HOST, ...Object.keys(MESSAGING_HOSTS)];
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
  /** Every RTDB connection in the order it opened, with each frame the server sent on it. */
  rtdb: RtdbLog[];
  /** Every AI Logic call the server answered, in arrival order. Empty without `ai`. */
  ai: AiReceived[];
  /** Every Storage call the server received, answered or not, in arrival order. */
  storage: StorageReceived[];
  /** Every Installations and FCM registrations call the server received, answered or not, in arrival order. */
  messaging: MessagingReceived[];
  close(): Promise<void>;
}

export interface ReplayOptions {
  /** Also answer Firestore over gRPC, with the `@grpc/grpc-js` and protos of the SDK installed in `projectDir`. */
  grpc?: { projectDir: string };
  /** Also answer AI Logic's generateContent, streamGenerateContent and countTokens (`ai.ts`). */
  ai?: boolean;
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
  if (first && ROUTED_HOSTS.includes(first)) return { host: first, path: `/${rest.join('/')}`, url };
  if (first === FIRESTORE_SERVICE) return { host: FIRESTORE_HOST, path: url.pathname, url };
  const host = (request.headers.host ?? '').replace(/:\d+$/, '');
  return ROUTED_HOSTS.includes(host) ? { host, path: url.pathname, url } : null;
}

/**
 * The path of a Storage call, or null for any other request: `/v0/b/...` as
 * `connectStorageEmulator` builds it, under a `/firebasestorage.googleapis.com`
 * segment as the seam rewrites it, or with that Host header.
 */
export function storageRouteOf(request: IncomingMessage): Route | null {
  const url = new URL(request.url ?? '/', 'http://replay.invalid');
  const [, first, ...rest] = url.pathname.split('/');
  if (first === STORAGE_HOST) return { host: STORAGE_HOST, path: `/${rest.join('/')}`, url };
  const host = (request.headers.host ?? '').replace(/:\d+$/, '');
  const isStoragePath = first === STORAGE_VERSION_SEGMENT || host === STORAGE_HOST;
  return isStoragePath ? { host: STORAGE_HOST, path: url.pathname, url } : null;
}

/** The path of an Installations or FCM registrations call, or null for any other request: under its host's segment, or with its Host header. */
export function messagingRouteOf(request: IncomingMessage): Route | null {
  const url = new URL(request.url ?? '/', 'http://replay.invalid');
  const [, first, ...rest] = url.pathname.split('/');
  if (first && Object.hasOwn(MESSAGING_HOSTS, first)) return { host: first, path: `/${rest.join('/')}`, url };
  const host = (request.headers.host ?? '').replace(/:\d+$/, '');
  return Object.hasOwn(MESSAGING_HOSTS, host) ? { host, path: url.pathname, url } : null;
}

export async function startReplayServer(recordings: Recording[], options: ReplayOptions = {}): Promise<ReplayServer> {
  const state = new ReplayState(recordings);
  const grpc = options.grpc ? await startGrpcReplay(state, options.grpc.projectDir) : null;
  const sessions = new Map<string, WebChannelSession>();
  const sockets = new Set<ServerSocket>();
  const rtdb = new RtdbShared();
  const ai: AiReceived[] | null = options.ai ? [] : null;
  const storage = new StorageReplay(state);
  const messaging = new MessagingReplay(state);
  let origin = '';
  const server = createServer((request, response) => {
    void handle({ state, rtdb, ai, storage, messaging, origin: () => origin }, sessions, request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(`pyric replay: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void upgrade(state, rtdb, sockets, request, socket, head).catch((error: unknown) => refuseUpgrade(state, request, socket, error));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    unmatched: state.unmatched,
    received: state.received,
    grpc,
    rtdb: rtdb.connections,
    ai: ai ?? [],
    storage: storage.received,
    messaging: messaging.received,
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

/** What every request on one server shares. `origin` is the server's own, known once it listens. */
interface Services {
  state: ReplayState;
  rtdb: RtdbShared;
  ai: AiReceived[] | null;
  storage: StorageReplay;
  messaging: MessagingReplay;
  origin: () => string;
}

async function handle(services: Services, sessions: Map<string, WebChannelSession>, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { state, rtdb, ai, storage, messaging } = services;
  allowCrossOrigin(request, response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  const report = REPORTS[request.url ?? ''];
  if (request.method === 'GET' && report) {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(report(state, rtdb, ai ?? [], storage.received, messaging.received)));
    return;
  }
  const storageRoute = storageRouteOf(request);
  if (storageRoute) return answerStorage(services, storageRoute, request, response);
  const messagingRoute = messagingRouteOf(request);
  if (messagingRoute) return answerMessaging(messaging, messagingRoute, request, response);
  const route = routeOf(request);
  const body = await readBody(request);
  const aiCall = ai && request.method === 'POST' ? aiCallOf(request.url ?? '') : null;
  if (aiCall) return answerAiCall(ai!, aiCall, request, response);
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

/**
 * What the server saw, for a caller in another process (`serve.ts`,
 * `process.ts`). `received` lists the Firestore and Auth requests in arrival
 * order, then the RTDB frames in arrival order, then the AI Logic calls in
 * arrival order, then the Storage calls in arrival order, then the
 * Installations and FCM registrations calls in arrival order.
 */
const REPORTS: Record<string, (state: ReplayState, rtdb: RtdbShared, ai: AiReceived[], storage: StorageReceived[], messaging: MessagingReceived[]) => Array<Received | RtdbReceived | AiReceived | StorageReceived | MessagingReceived> | Unmatched[]> = {
  '/__replay/received': (state, rtdb, ai, storage, messaging) => [...state.received, ...rtdb.received, ...ai, ...storage, ...messaging],
  '/__replay/unmatched': (state) => state.unmatched,
};

function answerAiCall(log: AiReceived[], call: NonNullable<ReturnType<typeof aiCallOf>>, request: IncomingMessage, response: ServerResponse): void {
  const appCheck = Boolean(request.headers['x-firebase-appcheck']);
  log.push({ rpc: 'ai', as: null, message: { ...call, appCheck } });
  const answer = answerAi(call.task, call.model, appCheck);
  const type = answer.kind === 'sse' ? 'text/event-stream' : 'application/json; charset=utf-8';
  response.writeHead(answer.status, { 'content-type': type });
  response.end(answer.kind === 'sse' ? answer.body : JSON.stringify(answer.body));
}

/** Answers one Storage call from the recordings, or fails it closed. The body is read raw: an upload carries bytes. */
async function answerStorage(services: Services, route: Route, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readRawBody(request);
  const method = request.method ?? 'GET';
  const call = readStorageRequest(services.state, method, route.path, route.url.searchParams, request.headers, body);
  if (!call) {
    services.state.unmatched.push({ rpc: 'http', as: null, request: { method, host: STORAGE_HOST, path: route.path } });
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end(`pyric replay: Storage ${route.path} is not an object or bucket path`);
    return;
  }
  const answer = services.storage.answer(call, services.origin());
  response.writeHead(answer.status, answer.headers);
  response.end(answer.body);
}

/** Answers one Installations or FCM registrations call from the recordings, or fails it closed. */
async function answerMessaging(messaging: MessagingReplay, route: Route, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request);
  const call = readMessagingRequest(MESSAGING_HOSTS[route.host]!, request.method ?? 'GET', route.path, request.headers, body);
  const answer = messaging.answer(call);
  response.writeHead(answer.status, answer.headers);
  response.end(answer.body);
}

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

/** An accepted WebSocket, whichever library accepted it. */
interface ServerSocket {
  send(text: string): void;
  close(): void;
  /** Drops the connection without a closing handshake, for shutdown. */
  terminate(): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

type Accept = (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<ServerSocket>;

/** The part of a `ws` socket the server uses. */
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

/** The part of a faye-websocket server socket the server uses. */
interface FayeSocket {
  send(text: string): boolean;
  close(): void;
  on(event: 'message', listener: (event: { data: string | Buffer }) => void): void;
  on(event: 'close', listener: () => void): void;
}

type FayeWebSocket = new (request: IncomingMessage, socket: Duplex, head: Buffer) => FayeSocket;

let accept: Promise<Accept> | null = null;

/**
 * How this runtime accepts a WebSocket, loaded on the first upgrade. Bun
 * provides `ws` itself, and faye-websocket never completes a handshake on
 * Bun's upgrade socket. Under `node` (`serve.ts`) the root workspace installs
 * no `ws`, so it uses faye-websocket from the `@firebase/database` that
 * `firebase/database` resolves to, which depends on it for its Node build.
 * The Bun tests cover the first, `rtdb-node.test.ts` the second.
 */
function webSockets(): Promise<Accept> {
  const isBun = process.versions.bun !== undefined;
  accept ??= isBun ? wsAccept() : Promise.resolve(fayeAccept());
  return accept;
}

async function wsAccept(): Promise<Accept> {
  const ws = (await import('ws')) as { WebSocketServer: new (options: { noServer: true }) => WsServer };
  const server = new ws.WebSocketServer({ noServer: true });
  return (request, socket, head) => new Promise((resolve) => server.handleUpgrade(request, socket, head, (accepted) => resolve({
    send: (text) => accepted.send(text),
    close: () => accepted.close(),
    terminate: () => accepted.terminate(),
    onMessage: (listener) => accepted.on('message', (data) => listener(data.toString('utf8'))),
    onClose: (listener) => accepted.on('close', listener),
  })));
}

function fayeAccept(): Accept {
  const firebaseDatabase = createRequire(import.meta.url).resolve('firebase/database');
  const database = createRequire(firebaseDatabase).resolve('@firebase/database');
  const WebSocket = createRequire(database)('faye-websocket') as FayeWebSocket;
  return async (request, socket, head) => {
    const accepted = new WebSocket(request, socket, head);
    return {
      send: (text) => { accepted.send(text); },
      close: () => accepted.close(),
      terminate: () => socket.destroy(),
      onMessage: (listener) => accepted.on('message', (event) => listener(event.data.toString())),
      onClose: (listener) => accepted.on('close', listener),
    };
  };
}

const RTDB_PATH = '/.ws';

/** Opens an RTDB connection on `/.ws` for the instance its `ns` names, or refuses the upgrade with a 404. */
async function upgrade(state: ReplayState, rtdb: RtdbShared, sockets: Set<ServerSocket>, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://replay.invalid');
  const instance = url.searchParams.get('ns');
  if (url.pathname !== RTDB_PATH || !instance) {
    state.unmatched.push({ rpc: 'http', as: null, request: { method: request.method ?? '', path: request.url ?? '' } });
    socket.end('HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\n\r\npyric replay: no recorded WebSocket at this path\n');
    return;
  }
  const ws = await (await webSockets())(request, socket, head);
  sockets.add(ws);
  const connection = new RtdbConnection(ws, state, rtdb, instance, request.headers.host ?? '');
  ws.onMessage((text) => connection.onFrame(text));
  ws.onClose(() => {
    sockets.delete(ws);
    connection.close();
  });
  connection.open();
}

/** An upgrade that failed (a WebSocket library would not load, say) is listed in `unmatched` with the reason, then its socket destroyed. */
export function refuseUpgrade(state: ReplayState, request: IncomingMessage, socket: Duplex, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  state.unmatched.push({ rpc: 'rtdb', as: null, request: { method: request.method ?? '', path: request.url ?? '', error: reason } });
  socket.destroy();
}

/** WebChannel's session header, and the upload headers a resumable Storage upload reads. */
const EXPOSED_HEADERS = ['x-http-session-id', 'x-goog-upload-status', 'x-goog-upload-url', 'x-goog-upload-size-received', 'x-goog-upload-chunk-granularity'];

function allowCrossOrigin(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (!origin) return;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-credentials', 'true');
  response.setHeader('access-control-allow-headers', request.headers['access-control-request-headers'] ?? '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  response.setHeader('access-control-expose-headers', EXPOSED_HEADERS.join(', '));
}

function readRawBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => resolve(Buffer.concat(parts)));
    request.on('error', reject);
  });
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
