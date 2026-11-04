// Records a real run as a recorded-exchange file. The recorder is a local
// forwarder: the seam sends the SDK's requests to it exactly as it sends them
// to a replay server, and it passes each one to the real host unchanged and
// streams the answer back unchanged. On the side it decodes what it relays
// (WebChannel forward batches and back-channel chunks, Auth REST bodies) and
// `stop()` returns the exchanges reduced to shapes and test-project values,
// checked by `assertShapesOnly`.
//
// It only ever forwards to `upstream(host)`, which defaults to the real host.
// Point it at a test project only: what it records is what that project holds.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AUTH_HOSTS, parseRestBody } from './auth.ts';
import { assertShapesOnly, type JsonObject, type Recording } from './format.ts';
import { passThroughFetch } from './seam.ts';
import { FIRESTORE_HOST, readBody, routeOf, type Route } from './server.ts';
import { Transcript, uidOfBearer, type RecordedListen, type RecordedWrite } from './transcript.ts';
import { parseForwardBody, splitChunks } from './webchannel.ts';

export interface RecorderOptions {
  /** The test project the run talks to. The recording refuses documents outside it. */
  project: string;
  /** Says where the recording came from, for the file's `source`. */
  source: string;
  /** The base URL each host is forwarded to. Defaults to `https://<host>`. */
  upstream?: (host: string) => string;
}

export interface Recorder {
  origin: string;
  /** Stops forwarding and returns the recording. Throws if anything in it is not a shape or test value. */
  stop(): Promise<Recording>;
}

type RecordedStream = RecordedListen | RecordedWrite;

const RELAYED_REQUEST_HEADERS = ['content-type', 'x-goog-api-key', 'x-goog-api-client', 'x-firebase-gmpid', 'x-client-version', 'x-firebase-client', 'x-firebase-appcheck', 'authorization'];
const RELAYED_RESPONSE_HEADERS = ['content-type', 'x-http-session-id'];

export async function startRecorder(options: RecorderOptions): Promise<Recorder> {
  const transcript = new Transcript(options.project, options.source);
  const streams = new Map<string, RecordedStream>();
  const upstream = options.upstream ?? ((host: string) => `https://${host}`);
  const server = createServer((request, response) => {
    void relay({ transcript, streams, lastArray: new Map(), upstream }, request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(`pyric recorder: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const recording = transcript.recording();
      assertShapesOnly(recording);
      return recording;
    },
  };
}

interface RelayContext {
  transcript: Transcript;
  streams: Map<string, RecordedStream>;
  /** The last back-channel array id decoded per session, so a resent array is decoded once. */
  lastArray: Map<string, number>;
  upstream: (host: string) => string;
}

async function relay(context: RelayContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const route = routeOf(request);
  if (!route) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('pyric recorder: not a recorded host');
    return;
  }
  const body = await readBody(request);
  // Observe before forwarding: the answer to a forward batch can reach the back channel before the batch's own response.
  const observe = observerFor(context, route, request, body);
  const abort = new AbortController();
  request.on('close', () => abort.abort());
  const answer = await passThroughFetch(`${context.upstream(route.host)}${route.path}${route.url.search}`, {
    method: request.method,
    headers: relayedHeaders(request),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
    signal: abort.signal,
  });
  const headers = Object.fromEntries(RELAYED_RESPONSE_HEADERS.flatMap((name) => {
    const value = answer.headers.get(name);
    return value === null ? [] : [[name, value]];
  }));
  response.writeHead(answer.status, headers);
  const decoder = new TextDecoder();
  let text = '';
  if (answer.body) {
    try {
      for await (const part of answer.body) {
        response.write(part);
        text += decoder.decode(part, { stream: true });
        text = observe.part(text, answer.status);
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  }
  observe.end(text + decoder.decode(), answer.status);
  response.end();
}

function relayedHeaders(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(RELAYED_REQUEST_HEADERS.flatMap((name) => {
    const value = request.headers[name];
    return typeof value === 'string' ? [[name, value]] : [];
  }));
}

/** Decodes one relayed exchange. `part` takes the text so far and returns what it has not consumed. */
interface Observer {
  part(text: string, status: number): string;
  end(text: string, status: number): void;
}

function observerFor(context: RelayContext, route: Route, request: IncomingMessage, body: string): Observer {
  if (AUTH_HOSTS.includes(route.host)) return authObserver(context, route, request, body);
  if (route.host === FIRESTORE_HOST) return channelObserver(context, route, request, body);
  return { part: () => '', end: () => {} };
}

function authObserver(context: RelayContext, route: Route, request: IncomingMessage, body: string): Observer {
  return {
    part: (text) => text,
    end: (text, status) => {
      const answer = parseRestBody(text) ?? {};
      context.transcript.auth({ method: request.method ?? 'GET', host: route.host, path: route.path, body: parseRestBody(body) }, { status, body: answer });
    },
  };
}

const CHANNEL_RPC = /\/google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel$/;

function channelObserver(context: RelayContext, route: Route, request: IncomingMessage, body: string): Observer {
  const rpc = CHANNEL_RPC.exec(route.path)?.[1];
  const sid = route.url.searchParams.get('SID');
  const isHandshake = request.method === 'POST' && (sid === null || sid === 'null');
  const isForward = request.method === 'POST' && !isHandshake;
  const batch = request.method === 'POST' ? parseForwardBody(body) : null;
  if (!rpc) return { part: () => '', end: () => {} };
  if (isForward && sid) for (const { message } of batch!.messages) context.streams.get(sid)?.fromClient(message);
  let stream: RecordedStream | undefined = sid ? context.streams.get(sid) : undefined;
  const take = (text: string): string => {
    const { payloads, rest } = splitChunks(text);
    for (const payload of payloads) {
      if (!Array.isArray(payload) || !Array.isArray(payload[0])) continue;
      for (const [arrayId, data] of payload as Array<[number, unknown[]]>) {
        const first = data[0];
        const isHandshakeArray = first === 'c' && isHandshake;
        if (isHandshakeArray) {
          const as = uidOfBearer(batch!.headers.authorization);
          stream = rpc === 'Listen' ? context.transcript.listenStream(as) : context.transcript.writeStream(as);
          context.streams.set(String(data[1]), stream);
          context.lastArray.set(String(data[1]), arrayId);
          for (const { message } of batch!.messages) stream.fromClient(message);
          continue;
        }
        const isResent = sid !== null && arrayId <= (context.lastArray.get(sid) ?? -1);
        if (isResent) continue;
        if (sid !== null) context.lastArray.set(sid, arrayId);
        const isMessage = typeof first === 'object' && first !== null;
        if (isMessage) stream?.fromServer(first as JsonObject);
      }
    }
    return rest;
  };
  return { part: (text) => take(text), end: (text) => { take(text); } };
}

