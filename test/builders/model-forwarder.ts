/**
 * The model forwarder: the harness's half of the model channel, outside the
 * sandbox. It listens on a Unix socket the run's bridge connects to, reads
 * one HTTP request per connection, and either refuses it with 403 (or 400,
 * 408, 431 for one it can't read) or sends it to the model API over TLS with
 * the real credential in place of the builder's placeholder
 * (`model-policy.ts` says which requests pass and which headers go on).
 *
 * The credential is the harness's own: it lives in this process and goes
 * only into the request to the model API. Nothing in the sandbox holds it.
 *
 * Every connection is one line of the run's channel record, written outside
 * the run directory: forwarded or refused, with the reason, the status, and
 * for a forwarded request the usage it metered and what that cost.
 *
 * Once a request's body is in, the forwarder checks it (`message-body.ts`:
 * JSON, client tools only, a numeric `max_tokens`) and reserves its worst
 * case on the run's meter (`model-meter.ts`). A request whose worst case
 * doesn't fit the run's cap or the round's total gets 403; one over the
 * run's two in flight gets 429 with `retry-after`.
 */
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import { hostInHeadStart, namedHost, parseHead, shownRequestLine, type RequestHead } from './http-head.ts';
import { channelEvent, listen, type ChannelOutcome, type ForwardNote, type Listening } from './model-channel.ts';
import { checkMessageBody, COUNT_TOKENS_PATH, type BodyCheck } from './message-body.ts';
import type { Reservation, RunMeter } from './model-meter.ts';
import { forwardedHeaders, MODEL_API_HOST, pathOf, requestRefusal, type RefusalReason } from './model-policy.ts';
import { costOf } from './model-prices.ts';
import { bodyFrom, framingOf, MAX_BODY_BYTES, type Framing } from './request-body.ts';
import { usageTap, type UsageTap } from './usage-tap.ts';

export interface Upstream {
  host: string;
  port: number;
  tls: boolean;
}

/** Where every allowed request goes. */
export const MODEL_API_UPSTREAM: Upstream = { host: MODEL_API_HOST, port: 443, tls: true };

export const MAX_HEAD_BYTES = 16 * 1024;
export const HEAD_TIMEOUT_MS = 10_000;
export const BODY_TIMEOUT_MS = 60_000;
/**
 * How long a forwarded request may take, from sending to the response's
 * end: claude's own default request timeout (`API_TIMEOUT_MS`, 10 minutes,
 * https://code.claude.com/docs/en/env-vars). Past it the forwarder aborts the
 * request and frees its slot, and the request keeps its whole reservation.
 */
export const UPSTREAM_TIMEOUT_MS = 600_000;
const HEAD_END = Buffer.from('\r\n\r\n');

export interface ForwarderOptions {
  socketPath: string;
  /** The channel record, a file outside the run directory, so nothing in the sandbox can write it. */
  record: string;
  /** The token sent to the model API; undefined for a builder with no model, whose every request is refused. */
  credential: string | undefined;
  meter: RunMeter;
  /**
   * Test seam: where an allowed request is sent. The harness never sets it,
   * so a run always reaches `MODEL_API_UPSTREAM` over TLS. The forwarder's
   * tests point it at a plain-HTTP server on loopback with a made-up
   * credential, so no test reaches the model API.
   */
  upstream?: Upstream;
  headTimeoutMs?: number;
  upstreamTimeoutMs?: number;
}

type HeadRead =
  | { kind: 'head'; raw: string; rest: Buffer }
  | { kind: 'closed'; raw: string }
  | { kind: 'timeout'; raw: string }
  | { kind: 'too-long'; raw: string };

/** Reads up to the end of the head, or reports why there is none. Reports exactly once. */
function readHead(socket: net.Socket, timeoutMs: number, done: (read: HeadRead) => void): void {
  let buffered = Buffer.alloc(0);
  let reported = false;
  const report = (read: HeadRead) => {
    if (reported) return;
    reported = true;
    clearTimeout(timer);
    socket.off('data', onData);
    done(read);
  };
  const raw = () => buffered.toString('latin1');
  const timer = setTimeout(() => report({ kind: 'timeout', raw: raw() }), timeoutMs);
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf(HEAD_END);
    const headTooLong = (end === -1 && buffered.length > MAX_HEAD_BYTES) || end > MAX_HEAD_BYTES;
    if (headTooLong) return report({ kind: 'too-long', raw: raw() });
    if (end === -1) return;
    report({ kind: 'head', raw: buffered.subarray(0, end).toString('latin1'), rest: buffered.subarray(end + HEAD_END.length) });
  };
  socket.on('data', onData);
  socket.once('close', () => report({ kind: 'closed', raw: raw() }));
}

type BodyRead = { kind: 'body'; body: Buffer } | { kind: 'malformed' } | { kind: 'timeout' } | { kind: 'closed' };

/**
 * Whether the bytes so far could hold the whole body, so that decoding them
 * is worth it: a body of known length once that many bytes are in, a chunked
 * one once the bytes end as its last chunk does. Decoding only then keeps a
 * large body from being copied and decoded once per packet.
 */
function mayBeComplete(framing: Framing, chunks: readonly Buffer[], total: number): boolean {
  if (framing.kind === 'none') return true;
  if (framing.kind === 'length') return total >= framing.length;
  const last = chunks.at(-1) ?? Buffer.alloc(0);
  const tail = last.length >= HEAD_END.length ? last : Buffer.concat(chunks.slice(-HEAD_END.length));
  return tail.subarray(-HEAD_END.length).equals(HEAD_END) || total > MAX_BODY_BYTES + MAX_HEAD_BYTES;
}

function readBody(socket: net.Socket, initial: Buffer, framing: Framing, done: (read: BodyRead) => void): void {
  const chunks: Buffer[] = [initial];
  let total = initial.length;
  let reported = false;
  const report = (read: BodyRead) => {
    if (reported) return;
    reported = true;
    clearTimeout(timer);
    socket.off('data', onData);
    done(read);
  };
  const check = () => {
    if (!mayBeComplete(framing, chunks, total)) return;
    const decoded = bodyFrom(Buffer.concat(chunks), framing);
    if (decoded.state === 'complete') report({ kind: 'body', body: decoded.body });
    if (decoded.state === 'malformed') report({ kind: 'malformed' });
  };
  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    total += chunk.length;
    check();
  };
  const timer = setTimeout(() => report({ kind: 'timeout' }), BODY_TIMEOUT_MS);
  socket.on('data', onData);
  socket.once('close', () => report({ kind: 'closed' }));
  check();
}

/** The host a line names: the model API for a forwarded request, else whatever the request named. */
function recordedHost(outcome: ChannelOutcome, head: RequestHead | undefined, raw: string): string {
  if (outcome.action === 'forwarded') return MODEL_API_HOST;
  const named = head === undefined ? hostInHeadStart(raw) : namedHost(head);
  return named ?? '(none)';
}

/** One connection's line in the record, written once, whichever way the connection ends. */
function attemptRecord(record: string) {
  let raw = '';
  let head: RequestHead | undefined;
  let written = false;
  return {
    saw(sent: string, parsed?: RequestHead) {
      raw = sent;
      head = parsed;
    },
    finish(outcome: ChannelOutcome) {
      if (written) return;
      written = true;
      const event = channelEvent(recordedHost(outcome, head, raw), shownRequestLine(raw), head, outcome);
      appendFileSync(record, `${JSON.stringify(event)}\n`);
    },
  };
}

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 408: 'Request Timeout', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large', 502: 'Bad Gateway', 504: 'Gateway Timeout' };
const ERROR_TYPE: Record<number, string> = { 403: 'permission_error', 429: 'rate_limit_error' };

/** Seconds a builder told to wait for a request in flight waits before it retries. */
const IN_FLIGHT_RETRY_AFTER_S = 2;

/** An error in the Messages API's own shape, so claude reports it as one; a 429 says when to retry. */
function respondWithError(socket: net.Socket, status: number, message: string): void {
  const body = JSON.stringify({ type: 'error', error: { type: ERROR_TYPE[status] ?? 'invalid_request_error', message: `pyric builder model channel: ${message}` } });
  const retry = status === 429 ? `retry-after: ${IN_FLIGHT_RETRY_AFTER_S}\r\n` : '';
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ''}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n${retry}connection: close\r\n\r\n${body}`);
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

/** The response head the builder gets: the model API's, framed by the connection closing. */
function responseHead(response: http.IncomingMessage): string {
  const lines = [`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ''}`];
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index] ?? '';
    if (!HOP_BY_HOP.has(name.toLowerCase())) lines.push(`${name}: ${response.rawHeaders[index + 1] ?? ''}`);
  }
  lines.push('connection: close');
  return `${lines.join('\r\n')}\r\n\r\n`;
}

interface Allowed {
  path: string;
  check: Extract<BodyCheck, { kind: 'allowed' }>;
  reservation: Reservation;
}

/**
 * What a request that ended is charged. A response cut off keeps its whole
 * reservation, however much of it was metered. One that ended is charged
 * what its usage says; with no usage, a token count and an error cost
 * nothing, and any other answer costs its reservation.
 */
function chargeAtEnd(allowed: Allowed, note: ForwardNote | null, status: number | null, costUsd: number | null): number {
  const reserved = allowed.reservation.reservedUsd;
  if (note !== null) return Math.max(reserved, costUsd ?? 0);
  if (costUsd !== null) return costUsd;
  const isFree = allowed.path === COUNT_TOKENS_PATH || status !== 200;
  return isFree ? 0 : reserved;
}

function forward(client: net.Socket, head: RequestHead, body: Buffer, credential: string, options: ForwarderOptions, attempt: ReturnType<typeof attemptRecord>, allowed: Allowed): void {
  const upstream = options.upstream ?? MODEL_API_UPSTREAM;
  const { reservation, check } = allowed;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  let reading: UsageTap | undefined;
  let status: number | null = null;
  const metered = () => {
    const usage = reading?.current();
    const costUsd = usage === undefined ? null : costOf(usage.tokens, usage.model, { speed: usage.speed ?? check.modifiers.speed, usOnly: check.modifiers.usOnly });
    return { usage, costUsd };
  };
  let finished = false;
  /** Settles and records the request the first time it ends; says whether this was that time. */
  const finish = (note: ForwardNote | null): boolean => {
    if (finished) return false;
    finished = true;
    clearTimeout(deadline);
    const { usage, costUsd } = metered();
    reservation.settle(chargeAtEnd(allowed, note, status, costUsd));
    attempt.finish({ action: 'forwarded', reason: note, status, usage, costUsd, reservedUsd: reservation.reservedUsd, chargedUsd: reservation.chargedUsd() });
    return true;
  };
  const deadline = setTimeout(() => {
    const answered = status !== null;
    status ??= 504;
    finish('upstream-timeout');
    request.destroy();
    if (answered) client.destroy();
    else respondWithError(client, 504, `the model API did not finish within ${upstreamTimeoutMs / 1000}s`);
  }, upstreamTimeoutMs);

  const transport = upstream.tls ? https : http;
  const request = transport.request({
    host: upstream.host,
    port: upstream.port,
    method: 'POST',
    path: head.target,
    headers: forwardedHeaders(head, credential, body.length),
    agent: false,
    ...(upstream.tls ? { servername: MODEL_API_HOST } : {}),
  }, (response) => {
    status = response.statusCode ?? null;
    const tap = usageTap(response.headers['content-type'], check.model);
    reading = tap;
    client.write(responseHead(response));
    response.on('data', (chunk: Buffer) => {
      tap.write(chunk);
      const flushed = client.write(chunk);
      if (flushed) return;
      response.pause();
      client.once('drain', () => response.resume());
    });
    response.on('end', () => {
      finish(null);
      client.end();
    });
    response.on('error', () => {
      finish('upstream-error');
      client.destroy();
    });
  });
  request.on('error', () => {
    const answered = status !== null;
    status ??= 502;
    if (!finish('upstream-error')) return;
    if (answered) client.destroy();
    else respondWithError(client, 502, 'the model API could not be reached');
  });
  client.once('close', () => {
    finish('client-closed');
    request.destroy();
  });
  request.end(body);
}

/** Checks a whole request's body and reserves its worst case: an `Allowed`, or why it is refused. */
function admit(head: RequestHead, body: Buffer, meter: RunMeter): Allowed | { status: number; reason: RefusalReason; message: string; names: string[] } {
  const path = pathOf(head.target);
  const check = checkMessageBody(path, body);
  if (check.kind === 'refused') return check;
  const reservation = meter.reserve(check.reservedUsd);
  if (typeof reservation !== 'string') return { path, check, reservation };
  const status = reservation === 'in-flight' ? 429 : 403;
  const message = `${reservation}: this request may cost up to $${check.reservedUsd.toFixed(4)}`;
  return { status, reason: reservation, message, names: [] };
}

function handle(client: net.Socket, options: ForwarderOptions): void {
  const attempt = attemptRecord(options.record);
  const refuse = (status: number, reason: RefusalReason, message: string = reason, refusedNames: string[] = []) => {
    attempt.finish({ action: 'refused', reason, status, usage: undefined, costUsd: null, refusedNames });
    respondWithError(client, status, message);
  };
  client.on('error', () => client.destroy());
  readHead(client, options.headTimeoutMs ?? HEAD_TIMEOUT_MS, (read) => {
    attempt.saw(read.raw);
    if (read.kind === 'closed') return attempt.finish({ action: 'refused', reason: 'closed-before-head', status: null, usage: undefined, costUsd: null });
    if (read.kind === 'timeout') return refuse(408, 'head-timeout');
    if (read.kind === 'too-long') return refuse(431, 'head-too-long');
    const head = parseHead(read.raw);
    attempt.saw(read.raw, head);
    if (head === undefined) return refuse(400, 'malformed');
    const policy = requestRefusal(head);
    if (policy !== undefined) return refuse(403, policy);
    const framing = framingOf(head);
    if (framing === undefined) return refuse(400, 'framing');
    const credential = options.credential;
    if (credential === undefined) return refuse(403, 'no-credential');
    readBody(client, read.rest, framing, (body) => {
      if (body.kind === 'malformed') return refuse(400, 'body-malformed');
      if (body.kind === 'timeout') return refuse(408, 'body-timeout');
      if (body.kind === 'closed') return attempt.finish({ action: 'refused', reason: 'closed-before-body', status: null, usage: undefined, costUsd: null });
      const admitted = admit(head, body.body, options.meter);
      if ('reason' in admitted) return refuse(admitted.status, admitted.reason, admitted.message, admitted.names);
      forward(client, head, body.body, credential, options, attempt, admitted);
    });
  });
}

/** Starts the forwarder on `socketPath`. */
export function startModelForwarder(options: ForwarderOptions): Promise<Listening> {
  return listen((server) => server.listen(options.socketPath), (client) => handle(client, options));
}
