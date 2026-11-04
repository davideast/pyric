// A local server that plays production Firebase for the real `firebase` web
// SDK: Firestore's Listen and Write streams over WebChannel and the Auth REST
// calls a sign-in makes, each answered from recorded exchanges. It listens on
// 127.0.0.1 only and fails closed: every request it cannot answer from a
// recording is refused and listed in `unmatched`.
//
// A request names the Google host it was meant for either as the first path
// segment (`http://127.0.0.1:<port>/firestore.googleapis.com/...`, how
// `routeFirebaseTo` in seam.ts rewrites it) or in its Host header.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { answerAuth, AUTH_HOSTS, parseRestBody } from './auth.ts';
import type { Recording } from './format.ts';
import { ListenStream, ReplayState, WriteStream, type Unmatched } from './firestore.ts';
import { parseForwardBody, WebChannelSession } from './webchannel.ts';

export const FIRESTORE_HOST = 'firestore.googleapis.com';
export const REPLAYED_HOSTS = [FIRESTORE_HOST, ...AUTH_HOSTS];

export interface ReplayServer {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** Every request no recording answered, in arrival order. */
  unmatched: Unmatched[];
  close(): Promise<void>;
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
  const host = (request.headers.host ?? '').replace(/:\d+$/, '');
  return REPLAYED_HOSTS.includes(host) ? { host, path: url.pathname, url } : null;
}

export async function startReplayServer(recordings: Recording[]): Promise<ReplayServer> {
  const state = new ReplayState(recordings);
  const sessions = new Map<string, WebChannelSession>();
  const server = createServer((request, response) => {
    void handle(state, sessions, request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(`pyric replay: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    unmatched: state.unmatched,
    close: () => closeServer(server, sessions),
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
