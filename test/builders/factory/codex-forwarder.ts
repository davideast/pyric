/**
 * The Codex forwarder: the harness's half of a factory session's model
 * channel, outside the sandbox. Like the Claude forwarder
 * (`../model-forwarder.ts`), it listens on a Unix socket in the run
 * directory that the bridge inside the sandbox pipes to, and it alone holds
 * the credential: it reads the Codex login (`codex-login.ts`) for each
 * request and puts it on the requests `codex-policy.ts` lets through, sent
 * to `chatgpt.com:443` over TLS. Codex inside holds no login at all.
 *
 * There is no dollar meter: the subscription bounds the spend, and its
 * usage limits come back on every response (`codex-rate-limit.ts`). Every
 * request is one line of the session's channel record, written outside the
 * run directory, with the reason, the status, and the limits the response
 * named. `runCodexSession` reads it for a reset time.
 */
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { Listening } from '../model-channel.ts';
import type { Upstream } from '../model-forwarder.ts';
import { MAX_BODY_BYTES } from '../request-body.ts';
import { expiryProblem, type LoginRead } from './codex-login.ts';
import { checkBody, CHATGPT_HOST, droppedHeaderNames, forwardedHeaders, lineRefusal, type CodexRefusal } from './codex-policy.ts';
import { rateLimitOf, type RateLimit } from './codex-rate-limit.ts';

export const CHATGPT_UPSTREAM: Upstream = { host: CHATGPT_HOST, port: 443, tls: true };

/** How long a forwarded request may take, sending to the response's end. A Codex turn at maximum reasoning can stream for a long time. */
export const UPSTREAM_TIMEOUT_MS = 30 * 60_000;

/** How much of an error response the forwarder keeps to read its limit error. */
const ERROR_BODY_BYTES = 64 * 1024;

export type ForwardNote = 'upstream-error' | 'upstream-timeout' | 'client-closed';

/** One request to the forwarder, as a line of the channel record. Names, never a header's or a token's value. */
export interface CodexChannelEvent {
  time: string;
  layer: 'codex-channel';
  kind: 'request';
  via: 'forwarder';
  method: string | null;
  path: string | null;
  action: 'forwarded' | 'refused';
  reason: CodexRefusal | ForwardNote | null;
  /** The status Codex got; null when the connection closed first. */
  status: number | null;
  model: string | null;
  rateLimit: RateLimit | null;
  /** What a refused body named: another model, server tool types. */
  refusedNames: string[];
  droppedHeaders: string[];
}

export interface CodexForwarderOptions {
  socketPath: string;
  /** The channel record, a file outside the run directory, so nothing in the sandbox can write it. */
  record: string;
  /** The one model the session may ask for. */
  model: string;
  /** Reads the login, once per request (`readCodexLogin`). Tests pass a made-up one. */
  login: () => LoginRead;
  /** Test seam: the forwarder's tests point it at a plain-HTTP server on loopback. A session always reaches `CHATGPT_UPSTREAM`. */
  upstream?: Upstream;
  now?: () => Date;
  upstreamTimeoutMs?: number;
}

type Fields = Pick<CodexChannelEvent, 'action' | 'reason' | 'status'> & Partial<Pick<CodexChannelEvent, 'model' | 'rateLimit' | 'refusedNames'>>;

/** Writes a request's line once, whichever way it ends. */
function recorder(options: CodexForwarderOptions, request: http.IncomingMessage) {
  let written = false;
  return (fields: Fields) => {
    if (written) return;
    written = true;
    const event: CodexChannelEvent = {
      time: (options.now?.() ?? new Date()).toISOString(),
      layer: 'codex-channel',
      kind: 'request',
      via: 'forwarder',
      method: request.method ?? null,
      path: request.url === undefined ? null : request.url.split('?')[0] ?? null,
      model: null,
      rateLimit: null,
      refusedNames: [],
      droppedHeaders: droppedHeaderNames(request.headers),
      ...fields,
    };
    appendFileSync(options.record, `${JSON.stringify(event)}\n`);
  };
}

type RecordLine = ReturnType<typeof recorder>;

const STATUS_FOR: Partial<{ [reason in CodexRefusal]: number }> = { 'body-too-large': 413, 'body-not-json': 400, 'encoded-body': 415, 'no-login': 401, 'login-expired': 401 };

/** A refusal in the shape of an OpenAI error, so Codex prints its message. */
function refuse(response: http.ServerResponse, record: RecordLine, reason: CodexRefusal, message: string, refusedNames: string[] = []): void {
  const status = STATUS_FOR[reason] ?? 403;
  record({ action: 'refused', reason, status, refusedNames });
  const body = JSON.stringify({ error: { type: 'pyric_codex_channel', code: reason, message: `pyric codex channel: ${message}` } });
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
  response.end(body);
}

type BodyRead = { kind: 'body'; body: Buffer } | { kind: 'too-large' } | { kind: 'closed' };

function readBody(request: http.IncomingMessage, done: (read: BodyRead) => void): void {
  const chunks: Buffer[] = [];
  let total = 0;
  let reported = false;
  const report = (read: BodyRead) => {
    if (reported) return;
    reported = true;
    done(read);
  };
  request.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) return report({ kind: 'too-large' });
    chunks.push(chunk);
  });
  request.once('end', () => report({ kind: 'body', body: Buffer.concat(chunks) }));
  request.once('close', () => report({ kind: 'closed' }));
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'set-cookie']);

function responseHeaders(upstream: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
  }
  return headers;
}

interface Admitted {
  body: Buffer;
  model: string;
  login: { accessToken: string; accountId: string };
}

function forward(request: http.IncomingMessage, response: http.ServerResponse, admitted: Admitted, options: CodexForwarderOptions, record: RecordLine): void {
  const upstream = options.upstream ?? CHATGPT_UPSTREAM;
  const transport = upstream.tls ? https : http;
  let status: number | null = null;
  let rateLimit: RateLimit | null = null;
  const finish = (reason: ForwardNote | null) => {
    clearTimeout(deadline);
    record({ action: 'forwarded', reason, status, model: admitted.model, rateLimit });
  };
  const outgoing = transport.request({
    host: upstream.host,
    port: upstream.port,
    method: 'POST',
    path: request.url,
    headers: forwardedHeaders(request.headers, admitted.login, admitted.body.length),
    agent: false,
    ...(upstream.tls ? { servername: CHATGPT_HOST } : {}),
  }, (incoming) => {
    status = incoming.statusCode ?? 502;
    const kept: Buffer[] = [];
    let keptBytes = 0;
    const isError = status >= 400;
    response.writeHead(status, responseHeaders(incoming));
    incoming.on('data', (chunk: Buffer) => {
      if (isError && keptBytes < ERROR_BODY_BYTES) {
        kept.push(chunk);
        keptBytes += chunk.length;
      }
      if (!response.write(chunk)) incoming.pause();
    });
    response.on('drain', () => incoming.resume());
    incoming.once('end', () => {
      rateLimit = rateLimitOf(status ?? 502, incoming.headers, Buffer.concat(kept).toString('utf8'), options.now?.());
      finish(null);
      response.end();
    });
    incoming.once('error', () => {
      finish('upstream-error');
      response.destroy();
    });
  });
  const deadline = setTimeout(() => {
    finish('upstream-timeout');
    outgoing.destroy();
    response.destroy();
  }, options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS);
  outgoing.once('error', () => {
    const answered = status !== null;
    status ??= 502;
    finish('upstream-error');
    if (answered) return response.destroy();
    response.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify({ error: { type: 'pyric_codex_channel', message: 'pyric codex channel: chatgpt.com could not be reached' } }));
  });
  response.once('close', () => {
    finish('client-closed');
    outgoing.destroy();
  });
  outgoing.end(admitted.body);
}

/** The login, or why the forwarder can't use it now. */
function usableLogin(options: CodexForwarderOptions): { accessToken: string; accountId: string } | { reason: CodexRefusal; message: string } {
  const read = options.login();
  if (!read.ok) return { reason: 'no-login', message: read.problem };
  const expired = expiryProblem(read.login, options.now?.() ?? new Date());
  if (expired !== undefined) return { reason: 'login-expired', message: expired };
  return read.login;
}

function handle(request: http.IncomingMessage, response: http.ServerResponse, options: CodexForwarderOptions): void {
  const record = recorder(options, request);
  request.on('error', () => request.destroy());
  const line = lineRefusal(request.method ?? '', request.url ?? '');
  if (line !== undefined) return refuse(response, record, line, `${request.method} ${request.url?.split('?')[0]} is not a Codex model request`);
  const encoding = request.headers['content-encoding'];
  const isEncoded = encoding !== undefined && encoding !== 'identity';
  if (isEncoded) return refuse(response, record, 'encoded-body', `a body sent with content-encoding ${encoding} can't be checked`);
  readBody(request, (read) => {
    if (read.kind === 'closed') return record({ action: 'refused', reason: 'client-closed', status: null });
    if (read.kind === 'too-large') return refuse(response, record, 'body-too-large', `the body is over ${MAX_BODY_BYTES} bytes`);
    const check = checkBody(read.body, options.model);
    if (!check.ok) return refuse(response, record, check.reason, `the body was refused (${check.reason})`, check.names);
    const login = usableLogin(options);
    if ('reason' in login) return refuse(response, record, login.reason, login.message);
    forward(request, response, { body: read.body, model: check.model, login }, options, record);
  });
}

/** Starts the forwarder on `socketPath`. */
export function startCodexForwarder(options: CodexForwarderOptions): Promise<Listening> {
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => handle(request, response, options));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => resolve({
      close: () => new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
    }));
  });
}
