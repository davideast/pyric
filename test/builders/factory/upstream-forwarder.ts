/**
 * The upstream forwarder: the harness's half of a factory session's model
 * channel, outside the sandbox. Like the round's forwarder
 * (`../model-forwarder.ts`), it listens on a Unix socket that the bridge
 * inside the sandbox pipes to, and it alone holds the credential. The
 * socket is in the session's sandbox directory, in the run's host
 * directory, bound read-only into that session's sandbox alone.
 *
 * For each request it applies the agent's upstream policy (`agent.ts`):
 * the request line, the headers that pass, and the body check. It reads the
 * credential, sets its headers last, and sends the request on to the
 * policy's upstream over TLS. Every request is one line of the session's
 * channel record, in the host directory, with the reason, the status and
 * the limits the response named. Names only, never a header's or a
 * token's value.
 */
import http from 'node:http';
import https from 'node:https';
import type { Listening } from '../model-channel.ts';
import type { Upstream } from '../model-forwarder.ts';
import { MAX_BODY_BYTES } from '../request-body.ts';
import type { CredentialRead, Headers, RateLimit, UpstreamPolicy } from './agent.ts';
import { appendFile } from './host-files.ts';

/** How much of an error response the forwarder keeps to read its limit error. */
const ERROR_BODY_BYTES = 64 * 1024;

export type ForwardNote = 'upstream-error' | 'upstream-timeout' | 'client-closed';

/** The forwarder's own refusals; the policy adds its own reasons. */
export type ForwarderRefusal = 'encoded-body' | 'body-too-large' | 'bad-header' | 'no-credential' | 'credential-expired';

/** One request to the forwarder, as a line of the channel record. */
export interface UpstreamEvent {
  time: string;
  layer: 'agent-upstream';
  kind: 'request';
  via: 'forwarder';
  method: string | null;
  path: string | null;
  action: 'forwarded' | 'refused';
  reason: string | null;
  /** The status the agent got; null when the connection closed first. */
  status: number | null;
  model: string | null;
  rateLimit: RateLimit | null;
  /** What a refusal named: another model, tool types, header names. */
  refusedNames: string[];
  droppedHeaders: string[];
}

export interface UpstreamForwarderOptions {
  socketPath: string;
  /** The channel record, in the run's host directory. */
  record: string;
  policy: UpstreamPolicy;
  /** Reads the credential, once per request. */
  credential: () => CredentialRead;
  /** Test seam: where requests are sent instead of the policy's upstream. The `host` header stays the policy's. */
  upstream?: Upstream;
  now?: () => Date;
  /** Told when a request fails in a way the forwarder did not expect; the session is then stopped. Never holds a value. */
  onFault?: (reason: string) => void;
}

type Fields = Pick<UpstreamEvent, 'action' | 'reason' | 'status'> & Partial<Pick<UpstreamEvent, 'model' | 'rateLimit' | 'refusedNames'>>;

/** Headers about this hop alone, which the forwarder sets for its own: never worth naming as dropped. */
const OWN_HOP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding']);

/** The names of the headers the agent sent that the forwarder drops. Names only. */
export function droppedHeaderNames(headers: Headers, policy: UpstreamPolicy): string[] {
  return Object.keys(headers).filter((name) => !policy.isForwardedHeader(name) && !OWN_HOP.has(name)).sort();
}

/** The headers sent on: the allowlisted ones, the hop's own, then the credential's, which nothing the agent sent replaces. */
export function forwardedHeaders(headers: Headers, policy: UpstreamPolicy, credential: Readonly<Record<string, string>>, bodyLength: number): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || !policy.isForwardedHeader(name)) continue;
    forwarded[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return { ...forwarded, host: policy.upstream.host, 'content-length': String(bodyLength), ...credential };
}

/** The names of headers Node would refuse to send, which would otherwise throw out of the request. */
export function unsendableHeaders(headers: Readonly<Record<string, string>>): string[] {
  return Object.entries(headers).flatMap(([name, value]) => {
    try {
      http.validateHeaderName(name);
      http.validateHeaderValue(name, value);
      return [];
    } catch {
      return [name];
    }
  });
}

/** Writes a request's line once, whichever way it ends. */
function recorder(options: UpstreamForwarderOptions, request: http.IncomingMessage) {
  let written = false;
  return (fields: Fields) => {
    if (written) return;
    written = true;
    const event: UpstreamEvent = {
      time: (options.now?.() ?? new Date()).toISOString(),
      layer: 'agent-upstream',
      kind: 'request',
      via: 'forwarder',
      method: request.method ?? null,
      path: request.url === undefined ? null : request.url.split('?')[0] ?? null,
      model: null,
      rateLimit: null,
      refusedNames: [],
      droppedHeaders: droppedHeaderNames(request.headers, options.policy),
      ...fields,
    };
    appendFile(options.record, `${JSON.stringify(event)}\n`);
  };
}

type RecordLine = ReturnType<typeof recorder>;

const STATUS_FOR: Record<string, number> = { 'body-too-large': 413, 'body-not-json': 400, 'encoded-body': 415, 'bad-header': 400, 'no-credential': 401, 'credential-expired': 401 };

/** A refusal in the error shape model APIs use, which agents print. */
function refuse(response: http.ServerResponse, record: RecordLine, reason: string, message: string, refusedNames: string[] = []): void {
  const status = STATUS_FOR[reason] ?? 403;
  record({ action: 'refused', reason, status, refusedNames });
  const body = JSON.stringify({ error: { type: 'pyric_agent_upstream', code: reason, message: `pyric upstream forwarder: ${message}` } });
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
  headers: Record<string, string>;
}

/** Streams the upstream's answer back, keeping the start of an error body to read its limit. */
function relay(incoming: http.IncomingMessage, response: http.ServerResponse, options: UpstreamForwarderOptions, done: (status: number, rateLimit: RateLimit | null, note: ForwardNote | null) => void): void {
  const status = incoming.statusCode ?? 502;
  const kept: Buffer[] = [];
  let keptBytes = 0;
  const isError = status >= 400;
  try {
    response.writeHead(status, responseHeaders(incoming));
  } catch {
    done(status, null, 'upstream-error');
    incoming.destroy();
    response.destroy();
    return;
  }
  incoming.on('data', (chunk: Buffer) => {
    if (isError && keptBytes < ERROR_BODY_BYTES) {
      kept.push(chunk);
      keptBytes += chunk.length;
    }
    if (!response.write(chunk)) incoming.pause();
  });
  response.on('drain', () => incoming.resume());
  incoming.once('end', () => {
    const rateLimit = options.policy.rateLimitOf(status, incoming.headers, Buffer.concat(kept).toString('utf8'), options.now?.() ?? new Date());
    done(status, rateLimit, null);
    response.end();
  });
  incoming.once('error', () => {
    done(status, null, 'upstream-error');
    response.destroy();
  });
}

function forward(request: http.IncomingMessage, response: http.ServerResponse, admitted: Admitted, options: UpstreamForwarderOptions, record: RecordLine): void {
  const upstream = options.upstream ?? options.policy.upstream;
  const transport = upstream.tls ? https : http;
  let status: number | null = null;
  const finish = (reason: ForwardNote | null, rateLimit: RateLimit | null = null) => {
    clearTimeout(deadline);
    record({ action: 'forwarded', reason, status, model: admitted.model, rateLimit });
  };
  const outgoing = transport.request({
    host: upstream.host,
    port: upstream.port,
    method: 'POST',
    path: request.url,
    headers: admitted.headers,
    agent: false,
    ...(upstream.tls ? { servername: options.policy.upstream.host } : {}),
  }, (incoming) => {
    status = incoming.statusCode ?? 502;
    relay(incoming, response, options, (_, rateLimit, note) => finish(note, rateLimit));
  });
  const deadline = setTimeout(() => {
    finish('upstream-timeout');
    outgoing.destroy();
    response.destroy();
  }, options.policy.timeoutMs);
  outgoing.once('error', () => {
    const answered = status !== null;
    status ??= 502;
    finish('upstream-error');
    if (answered) return response.destroy();
    response.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify({ error: { type: 'pyric_agent_upstream', message: 'pyric upstream forwarder: the upstream could not be reached' } }));
  });
  response.once('close', () => {
    finish('client-closed');
    outgoing.destroy();
  });
  outgoing.end(admitted.body);
}

/** The credential's headers, or why the forwarder can't use it now. */
function usableCredential(options: UpstreamForwarderOptions): { headers: Readonly<Record<string, string>> } | { reason: ForwarderRefusal; message: string } {
  const read = options.credential();
  if (!read.ok) return { reason: 'no-credential', message: read.problem };
  const expired = read.credential.problemAt(options.now?.() ?? new Date());
  if (expired !== undefined) return { reason: 'credential-expired', message: expired };
  return { headers: read.credential.headers };
}

function admit(request: http.IncomingMessage, response: http.ServerResponse, body: Buffer, options: UpstreamForwarderOptions, record: RecordLine): void {
  const check = options.policy.checkBody(body);
  if (!check.ok) return refuse(response, record, check.reason, `the body was refused (${check.reason})`, check.names);
  const credential = usableCredential(options);
  if ('reason' in credential) return refuse(response, record, credential.reason, credential.message);
  const headers = forwardedHeaders(request.headers, options.policy, credential.headers, body.length);
  const unsendable = unsendableHeaders(headers);
  if (unsendable.length > 0) return refuse(response, record, 'bad-header', `headers that can't be sent: ${unsendable.join(', ')}`, unsendable);
  forward(request, response, { body, model: check.model, headers }, options, record);
}

function handle(request: http.IncomingMessage, response: http.ServerResponse, options: UpstreamForwarderOptions): void {
  const record = recorder(options, request);
  request.on('error', () => request.destroy());
  const line = options.policy.lineRefusal(request.method ?? '', request.url ?? '');
  if (line !== undefined) return refuse(response, record, line, `${request.method} ${request.url?.split('?')[0]} is not a model request this agent makes`);
  const encoding = request.headers['content-encoding'];
  const isEncoded = encoding !== undefined && encoding !== 'identity';
  if (isEncoded) return refuse(response, record, 'encoded-body', `a body sent with content-encoding ${encoding} can't be checked`);
  readBody(request, (read) => {
    if (read.kind === 'closed') return record({ action: 'refused', reason: 'client-closed', status: null });
    if (read.kind === 'too-large') return refuse(response, record, 'body-too-large', `the body is over ${MAX_BODY_BYTES} bytes`);
    guarded(response, options, () => admit(request, response, read.body, options, record));
  });
}

/** Runs `step`; anything it throws drops this request and is reported as a fault, never thrown out of the harness. */
function guarded(response: http.ServerResponse, options: UpstreamForwarderOptions, step: () => void): void {
  try {
    step();
  } catch (error) {
    // The code alone: a header error's message can quote the header's value.
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : 'unknown';
    response.destroy();
    options.onFault?.(`the upstream forwarder dropped a request that failed (${code})`);
  }
}

/** Starts the forwarder on `socketPath`. */
export function startUpstreamForwarder(options: UpstreamForwarderOptions): Promise<Listening> {
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => guarded(response, options, () => handle(request, response, options)));
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
