/**
 * The provider forwarder: how a factory sandbox reaches the media provider
 * without holding its key. Like the upstream forwarder
 * (`upstream-forwarder.ts`), it listens on a Unix socket that a bridge
 * inside the sandbox pipes to, and it alone holds the key. Inside, the app
 * has a placeholder key that only turns its media routes on.
 *
 * Each request is allowed by method, path and model, else refused with a
 * named reason:
 *
 * - `POST /v1beta/interactions` with a body `model` in the price table;
 * - `POST /v1beta/models/<model in the table>:generateContent`;
 * - `GET /v1beta/interactions/<id>`, polling, which is free.
 *
 * Video, file uploads, model listing and streaming are refused. The
 * forwarder drops the app's `x-goog-api-key` and any `key=` query
 * parameter, sets the real key, read once per request, and sends the call
 * over TLS to the one fixed host (`PROVIDER_HOST`), whatever `Host` the app
 * named. Redirects are never followed. A billable call reserves its price in
 * the ledger (`provider-ledger.ts`) before it is sent.
 *
 * Every request is one line of `<run>.host/provider/calls.jsonl`, with the
 * path without its query. Never a header's value or a query string.
 */
import http from 'node:http';
import https from 'node:https';
import type { Listening } from '../model-channel.ts';
import type { Upstream } from '../model-forwarder.ts';
import { MAX_BODY_BYTES } from '../request-body.ts';
import { appendFile } from './host-files.ts';
import type { CallerKind, CallOutcome, LedgerReservation, LedgerRefusal, ProviderLedger } from './provider-ledger.ts';
import { bareModel, priceOf, PROVIDER_HOST } from './provider-prices.ts';

/** How long one call may take, polling included, before it is cut off. */
export const PROVIDER_TIMEOUT_MS = 5 * 60 * 1000;

/** The key placeholder the sandbox holds; it only turns the app's routes on. */
export const PLACEHOLDER_KEY = 'factory-forwarded';

export type ProviderKeyRead = { ok: true; key: string } | { ok: false; problem: string };

export type ProviderRefusal = 'path' | 'model' | 'method' | 'streaming' | 'body-not-json' | 'body-too-large' | 'encoded-body' | 'no-key' | LedgerRefusal;

/** One request to the forwarder, as a line of the calls record. */
export interface ProviderCall {
  time: string;
  caller: CallerKind;
  method: string | null;
  path: string | null;
  model: string | null;
  action: 'forwarded' | 'refused';
  reason: string | null;
  /** The status the app got; null when the connection closed first. */
  status: number | null;
  chargedUsd: number;
}

export interface ProviderUpstream extends Upstream {
  /** Test seam: the certificate authority the fake upstream's certificate is signed by. */
  ca?: string;
}

export interface ProviderForwarderOptions {
  socketPath: string;
  /** Who calls through this socket; the ledger caps each kind. */
  caller: CallerKind;
  ledger: ProviderLedger;
  /** `<run>.host/provider/calls.jsonl`. */
  calls: string;
  /** Reads the key, once per request. */
  credential: () => ProviderKeyRead;
  /** Test seam: where calls are sent instead of `PROVIDER_HOST`. The TLS name and `host` header stay `PROVIDER_HOST`. */
  upstream?: ProviderUpstream;
  timeoutMs?: number;
  now?: () => Date;
  /** Told when a request fails in a way the forwarder did not expect. Never holds a value. */
  onFault?: (reason: string) => void;
}

const DEFAULT_UPSTREAM: ProviderUpstream = { host: PROVIDER_HOST, port: 443, tls: true };

/** The app's headers that pass. The key's header, cookies and the hop's own are never among them. */
const FORWARDED_HEADERS = new Set(['content-type', 'accept', 'accept-encoding', 'user-agent', 'x-goog-api-client']);

/** Response headers the app never gets: the hop's own, cookies, and where a redirect points. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'set-cookie', 'location']);

const INTERACTIONS = '/v1beta/interactions';
const GENERATE_CONTENT = /^\/v1beta\/models\/([A-Za-z0-9._-]+):generateContent$/;
const INTERACTION = /^\/v1beta\/interactions\/([A-Za-z0-9._-]+)$/;

/** What a request line asks for, once its method and path are allowed. */
export type Route =
  | { kind: 'interactions' }
  | { kind: 'generate'; model: string }
  | { kind: 'poll' }
  | { kind: 'refused'; reason: 'path' | 'model' | 'method' };

export function routeOf(method: string, path: string): Route {
  const generate = GENERATE_CONTENT.exec(path);
  const isPost = method === 'POST';
  if (path === INTERACTIONS) return isPost ? { kind: 'interactions' } : { kind: 'refused', reason: 'method' };
  if (INTERACTION.test(path)) return method === 'GET' ? { kind: 'poll' } : { kind: 'refused', reason: 'method' };
  if (generate === null) return { kind: 'refused', reason: 'path' };
  const model = generate[1] ?? '';
  if (!isPost) return { kind: 'refused', reason: 'method' };
  return priceOf(model) === undefined ? { kind: 'refused', reason: 'model' } : { kind: 'generate', model };
}

/** The query sent on: the app's, without any `key`. */
export function forwardedQuery(url: string): string {
  const at = url.indexOf('?');
  if (at < 0) return '';
  const params = new URLSearchParams(url.slice(at + 1));
  params.delete('key');
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

export function forwardedHeaders(headers: http.IncomingHttpHeaders, key: string, bodyLength: number): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || !FORWARDED_HEADERS.has(name)) continue;
    forwarded[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return { ...forwarded, host: PROVIDER_HOST, 'content-length': String(bodyLength), 'x-goog-api-key': key };
}

function responseHeaders(upstream: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
  }
  return headers;
}

type Fields = Pick<ProviderCall, 'action' | 'reason' | 'status'> & Partial<Pick<ProviderCall, 'model' | 'chargedUsd'>>;

/** Writes a request's line once, whichever way it ends. */
function recorder(options: ProviderForwarderOptions, request: http.IncomingMessage) {
  let written = false;
  return (fields: Fields) => {
    if (written) return;
    written = true;
    const call: ProviderCall = {
      time: (options.now?.() ?? new Date()).toISOString(),
      caller: options.caller,
      method: request.method ?? null,
      path: request.url === undefined ? null : request.url.split('?')[0] ?? null,
      model: null,
      chargedUsd: 0,
      ...fields,
    };
    appendFile(options.calls, `${JSON.stringify(call)}\n`);
  };
}

type RecordLine = ReturnType<typeof recorder>;

const STATUS_FOR: Record<string, number> = {
  'body-not-json': 400, 'body-too-large': 413, 'encoded-body': 415, 'no-key': 503,
  'run-cap': 429, 'caller-cap': 429, 'in-flight': 429, 'ledger-unreadable': 503,
};

const IS_BUDGET = new Set(['run-cap', 'caller-cap', 'in-flight']);

/** A refusal in the provider's error shape, which the app's client reads. */
function refuse(response: http.ServerResponse, record: RecordLine, reason: ProviderRefusal, message: string, model: string | null = null): void {
  const status = STATUS_FOR[reason] ?? 403;
  record({ action: 'refused', reason, status, model });
  const isBudget = IS_BUDGET.has(reason);
  const error = isBudget
    ? { code: 429, status: 'RESOURCE_EXHAUSTED', message: `factory provider budget reached (${reason})` }
    : { code: status, status: status === 403 ? 'PERMISSION_DENIED' : 'FAILED_PRECONDITION', message: `pyric provider forwarder: ${message}`, reason };
  const body = JSON.stringify({ error });
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

type BodyCheck = { ok: true; model: string | null } | { ok: false; reason: ProviderRefusal; message: string; model?: string };

/** The body's model, for an interactions call, and whether the call streams. */
function checkBody(route: Route, body: Buffer): BodyCheck {
  if (route.kind === 'poll') return { ok: true, model: null };
  let parsed: unknown;
  try {
    parsed = body.length === 0 && route.kind === 'generate' ? {} : JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, reason: 'body-not-json', message: 'the body is not JSON' };
  }
  const fields = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (fields.stream === true) return { ok: false, reason: 'streaming', message: 'streaming calls are not metered' };
  if (route.kind === 'generate') return { ok: true, model: route.model };
  const model = typeof fields.model === 'string' ? bareModel(fields.model) : null;
  if (model === null || priceOf(model) === undefined) return { ok: false, reason: 'model', message: `the model ${model ?? '(none)'} is not one a factory run may call`, model: model ?? undefined };
  return { ok: true, model };
}

interface Admitted {
  method: 'GET' | 'POST';
  path: string;
  body: Buffer;
  model: string | null;
  headers: Record<string, string>;
  reservation: LedgerReservation | null;
}

function forward(response: http.ServerResponse, admitted: Admitted, options: ProviderForwarderOptions, record: RecordLine): void {
  const upstream = options.upstream ?? DEFAULT_UPSTREAM;
  const transport = upstream.tls ? https : http;
  const chargedUsd = admitted.reservation?.reservedUsd ?? 0;
  let status: number | null = null;
  const finish = (outcome: CallOutcome, reason: string | null) => {
    clearTimeout(deadline);
    admitted.reservation?.settle(outcome);
    record({ action: 'forwarded', reason, status, model: admitted.model, chargedUsd });
  };
  const outgoing = transport.request({
    host: upstream.host,
    port: upstream.port,
    method: admitted.method,
    path: admitted.path,
    headers: admitted.headers,
    agent: false,
    ...(upstream.tls ? { servername: PROVIDER_HOST, ...(upstream.ca === undefined ? {} : { ca: upstream.ca }) } : {}),
  }, (incoming) => {
    status = incoming.statusCode ?? 502;
    const outcome: CallOutcome = status >= 400 ? 'refused-upstream' : 'complete';
    try {
      response.writeHead(status, responseHeaders(incoming));
    } catch {
      finish('upstream-error', 'upstream-error');
      incoming.destroy();
      response.destroy();
      return;
    }
    // Streamed through: an image or a clip can be large, and only requests are capped.
    incoming.pipe(response);
    incoming.once('end', () => finish(outcome, null));
    incoming.once('error', () => {
      finish('cut-off', 'upstream-error');
      response.destroy();
    });
    incoming.once('aborted', () => {
      finish('cut-off', 'upstream-error');
      response.destroy();
    });
  });
  const deadline = setTimeout(() => {
    finish('cut-off', 'upstream-timeout');
    outgoing.destroy();
    response.destroy();
  }, options.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  outgoing.once('error', () => {
    const answered = status !== null;
    status ??= 502;
    finish(answered ? 'cut-off' : 'upstream-error', 'upstream-error');
    if (answered) return response.destroy();
    response.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify({ error: { code: 502, status: 'UNAVAILABLE', message: 'pyric provider forwarder: the provider could not be reached' } }));
  });
  response.once('close', () => {
    finish('cut-off', 'client-closed');
    outgoing.destroy();
  });
  outgoing.end(admitted.body);
}

function admit(request: http.IncomingMessage, response: http.ServerResponse, route: Route, body: Buffer, options: ProviderForwarderOptions, record: RecordLine): void {
  const check = checkBody(route, body);
  if (!check.ok) return refuse(response, record, check.reason, check.message, check.model ?? null);
  const read = options.credential();
  if (!read.ok) return refuse(response, record, 'no-key', 'the provider key could not be read');
  const price = check.model === null ? undefined : priceOf(check.model);
  let reservation: LedgerReservation | null = null;
  if (price !== undefined && check.model !== null) {
    const reserved = options.ledger.reserve(options.caller, check.model, price.usdPerCall);
    if (typeof reserved === 'string') return refuse(response, record, reserved, `the call was refused (${reserved})`, check.model);
    reservation = reserved;
  }
  const url = request.url ?? '';
  const path = `${url.split('?')[0] ?? ''}${forwardedQuery(url)}`;
  const method = route.kind === 'poll' ? 'GET' : 'POST';
  forward(response, { method, path, body, model: check.model, headers: forwardedHeaders(request.headers, read.key, body.length), reservation }, options, record);
}

function handle(request: http.IncomingMessage, response: http.ServerResponse, options: ProviderForwarderOptions): void {
  const record = recorder(options, request);
  request.on('error', () => request.destroy());
  const path = (request.url ?? '').split('?')[0] ?? '';
  const route = routeOf(request.method ?? '', path);
  if (route.kind === 'refused') return refuse(response, record, route.reason, `${request.method} ${path} is not a call a factory run may make`);
  const encoding = request.headers['content-encoding'];
  const isEncoded = encoding !== undefined && encoding !== 'identity';
  if (isEncoded) return refuse(response, record, 'encoded-body', `a body sent with content-encoding ${encoding} can't be checked`);
  readBody(request, (read) => {
    if (read.kind === 'closed') return record({ action: 'refused', reason: 'client-closed', status: null });
    if (read.kind === 'too-large') return refuse(response, record, 'body-too-large', `the body is over ${MAX_BODY_BYTES} bytes`);
    guarded(response, options, () => admit(request, response, route, read.body, options, record));
  });
}

/** Runs `step`; anything it throws drops this request and is reported as a fault, never thrown out of the harness. */
function guarded(response: http.ServerResponse, options: ProviderForwarderOptions, step: () => void): void {
  try {
    step();
  } catch (error) {
    // The code alone: a header error's message can quote the header's value.
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : 'unknown';
    response.destroy();
    options.onFault?.(`the provider forwarder dropped a request that failed (${code})`);
  }
}

/** Starts the forwarder on `socketPath`. */
export function startProviderForwarder(options: ProviderForwarderOptions): Promise<Listening> {
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
