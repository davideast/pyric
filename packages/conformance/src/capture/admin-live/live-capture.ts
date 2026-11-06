/**
 * What capture A (Admin) (issue #2304, step C-1) needs beyond the other live
 * captures: recorders for the three wires firebase-admin uses, the
 * placeholders its answers need, the run-id notice, and the cleanup that
 * removes the run's user, documents, RTDB path and objects and reads each back.
 *
 * The wires:
 *   - gRPC: Firestore, through the `@grpc/grpc-js` copy google-gax loads. The
 *     recorder wraps `Client.prototype.makeUnaryRequest`,
 *     `makeServerStreamRequest` and `makeBidiStreamRequest` and keeps each
 *     request and response object, the final status, its details and the
 *     trailer names. Nothing is proxied.
 *   - `https.request`: Auth (`identitytoolkit.googleapis.com`), the ID token
 *     cert fetch, and Storage (gaxios 6 sends through node-fetch 2, which calls
 *     `https.request`). Only those hosts are recorded, so every token exchange
 *     is dropped whole.
 *   - RTDB: the data messages of the standalone database's persistent
 *     connection. The standalone build bundles faye-websocket, so the socket
 *     class cannot be swapped as `rtdb-live` does; the recorder wraps
 *     `sendRequest` and `onDataMessage_` instead, and drops the `gauth` frame
 *     and its answer.
 *
 * The context (oracle credential, web config, run id) and redaction come from
 * `../rtdb-live/live-capture.ts`, so every live capture shares one credential
 * path and one list of credential patterns. This file reads no credential.
 */
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { Redactor } from '../rtdb-live/live-capture.ts';

/** The root every live capture writes under, in Firestore, RTDB and Storage. */
export const RUN_ROOT = 'pyric_oracle';

export const runPathFor = (runId: string): string => `${RUN_ROOT}/${runId}`;
export const userEmailFor = (runId: string): string => `pyric-admin-capture-${runId}@example.com`;

/** The variables a CI runner sets. Capture A (Admin) reaches production, so it never runs there. */
const CI_VARIABLES = ['CI', 'GITHUB_ACTIONS'] as const;

export function captureRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  const set = CI_VARIABLES.filter((name) => (env[name] ?? '') !== '');
  if (set.length > 0) return `capture A (Admin) reaches a production project, so it does not run in CI (${set.join(' and ')} set). Run it by hand.`;
  if ((env.FIRESTORE_PREFER_REST ?? '') !== '') return 'FIRESTORE_PREFER_REST is set, so Firestore would not use gRPC; unset it.';
  const emulators = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST'];
  const pointed = emulators.filter((name) => (env[name] ?? '') !== '');
  if (pointed.length > 0) return `${pointed.join(' and ')} set, so the run would not reach production; unset them.`;
  return null;
}

// ─── Run id notice ────────────────────────────────────────────────────────

export function newRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Where every run id is appended, so a run that stops partway can still be cleaned up. */
export function runIdFile(): string {
  return join(tmpdir(), 'pyric-capture-admin-run-ids.log');
}

export interface RunIdNotice {
  write?: (line: string) => void;
  file?: string;
}

/**
 * Print the run id and its cleanup command before anything is created, and
 * append both to the run-id file. The run id is not a credential; the
 * recording still reads `<run>`.
 */
export function announceRunId(runId: string, notice: RunIdNotice = {}): string {
  const line = `[capture-admin] run ${runId}; if it stops partway, run the cleanup with --cleanup ${runId}`;
  (notice.write ?? console.log)(line);
  appendFileSync(notice.file ?? runIdFile(), `${new Date().toISOString()} ${line}\n`);
  return line;
}

// ─── Placeholders ─────────────────────────────────────────────────────────

/** Fields whose value differs on every run, by the placeholder kind they get. */
const FIELD_KINDS: Record<string, string> = {
  transaction: 'transaction',
  readTime: 'read-time',
  updateTime: 'update-time',
  createTime: 'create-time',
  commitTime: 'commit-time',
  resumeToken: 'resume-token',
  generation: 'generation',
  etag: 'etag',
  md5Hash: 'md5',
  crc32c: 'crc32c',
  timeCreated: 'time',
  updated: 'time',
  timeStorageClassUpdated: 'time',
  timeFinalized: 'time',
  createdAt: 'auth-time',
  lastLoginAt: 'auth-time',
  lastRefreshAt: 'auth-time',
  passwordUpdatedAt: 'auth-time',
  validSince: 'auth-time',
  passwordHash: 'password-hash',
  salt: 'salt',
  nextPageToken: 'page-token',
};

/**
 * Numbered placeholders: the same value always gets the same one. A string
 * value is also added to the redactor, so it is replaced wherever else it
 * appears in the file (a path, a link, another message).
 */
export class Placeholders {
  private readonly seen = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  private readonly redactor: Redactor;

  constructor(redactor: Redactor) {
    this.redactor = redactor;
  }

  number(kind: string, value: unknown): string {
    const key = `${kind}\u0000${JSON.stringify(value)}`;
    const known = this.seen.get(key);
    if (known) return known;
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    const placeholder = `<${kind}-${n}>`;
    this.seen.set(key, placeholder);
    if (typeof value === 'string') this.redactor.add(value, placeholder);
    return placeholder;
  }

  /** `value` as plain JSON: bytes become base64, and per-run fields become placeholders. */
  json(value: unknown): unknown {
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    if (Array.isArray(value)) return value.map((item) => this.json(item));
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (field === undefined) continue;
      const kind = FIELD_KINDS[key];
      out[key] = kind === undefined || field === null ? this.json(field) : this.number(kind, this.json(field));
    }
    return out;
  }
}

/** A recorder's current operation; the script sets it before each step. */
export interface Stamp {
  op: string;
  /** While true, nothing is recorded (the client sign-in, which is not an Admin call). */
  paused: boolean;
  now(): number;
}

export function newStamp(): Stamp {
  const start = performance.now();
  return { op: 'setup', paused: false, now: () => Math.round((performance.now() - start) * 10) / 10 };
}

// ─── gRPC ─────────────────────────────────────────────────────────────────

export interface GrpcExchange {
  seq: number;
  t: number;
  op: string;
  kind: 'unary' | 'server-stream' | 'bidi';
  /** `google.firestore.v1.Firestore/Commit` and the like, without the leading slash. */
  method: string;
  requests: unknown[];
  responses: Array<{ t: number; message: unknown }>;
  status: { code: number; details: string; trailers: string[] } | null;
}

interface GrpcStatus {
  code: number;
  details: string;
  metadata?: { getMap(): Record<string, unknown> };
}

interface GrpcCall {
  on(event: 'status', listener: (status: GrpcStatus) => void): unknown;
  push?: (chunk: unknown) => boolean;
  write?: (chunk: unknown, ...rest: unknown[]) => boolean;
}

type ClientMethod = (this: unknown, ...args: unknown[]) => GrpcCall;
type GrpcClientPrototype = Record<'makeUnaryRequest' | 'makeServerStreamRequest' | 'makeBidiStreamRequest', ClientMethod>;

/** The `@grpc/grpc-js` copy `@google-cloud/firestore` loads through firebase-admin. */
export function firestoreGrpcClient(): { prototype: GrpcClientPrototype } {
  const fromAdmin = createRequire(import.meta.resolve('firebase-admin/firestore'));
  const fromFirestore = createRequire(fromAdmin.resolve('@google-cloud/firestore'));
  const fromGax = createRequire(fromFirestore.resolve('google-gax'));
  return (fromGax('@grpc/grpc-js') as { Client: { prototype: GrpcClientPrototype } }).Client;
}

export class GrpcRecorder {
  readonly exchanges: GrpcExchange[] = [];
  private readonly stamp: Stamp;
  private readonly placeholders: Placeholders;

  constructor(stamp: Stamp, placeholders: Placeholders) {
    this.stamp = stamp;
    this.placeholders = placeholders;
  }

  /** Wraps the three request methods on `client.prototype`; returns the uninstall. */
  install(client: { prototype: GrpcClientPrototype }): () => void {
    const proto = client.prototype;
    const real = { ...proto };
    proto.makeUnaryRequest = this.wrap(real.makeUnaryRequest, 'unary');
    proto.makeServerStreamRequest = this.wrap(real.makeServerStreamRequest, 'server-stream');
    proto.makeBidiStreamRequest = this.wrap(real.makeBidiStreamRequest, 'bidi');
    return () => Object.assign(proto, real);
  }

  private wrap(real: ClientMethod, kind: GrpcExchange['kind']): ClientMethod {
    const recorder = this;
    return function (this: unknown, ...args: unknown[]): GrpcCall {
      if (recorder.stamp.paused) return real.apply(this, args);
      const exchange = recorder.begin(kind, String(args[0]));
      if (kind !== 'bidi') exchange.requests.push(recorder.placeholders.json(args[3]));
      const last = args.length - 1;
      if (kind === 'unary' && typeof args[last] === 'function') {
        const callback = args[last] as (error: unknown, value?: unknown) => void;
        args[last] = (error: unknown, value?: unknown) => {
          if (value !== undefined) recorder.response(exchange, value);
          callback(error, value);
        };
      }
      const call = real.apply(this, args);
      recorder.tee(exchange, call);
      return call;
    };
  }

  private begin(kind: GrpcExchange['kind'], path: string): GrpcExchange {
    const exchange: GrpcExchange = {
      seq: this.exchanges.length + 1,
      t: this.stamp.now(),
      op: this.stamp.op,
      kind,
      method: path.replace(/^\//, ''),
      requests: [],
      responses: [],
      status: null,
    };
    this.exchanges.push(exchange);
    return exchange;
  }

  private response(exchange: GrpcExchange, message: unknown): void {
    exchange.responses.push({ t: this.stamp.now(), message: this.placeholders.json(message) });
  }

  /** Reads what the call pushes and is written, without adding a reader of its own. */
  private tee(exchange: GrpcExchange, call: GrpcCall): void {
    const push = call.push?.bind(call);
    if (push && exchange.kind !== 'unary') {
      call.push = (chunk: unknown) => {
        if (chunk !== null) this.response(exchange, chunk);
        return push(chunk);
      };
    }
    const write = call.write?.bind(call);
    if (write && exchange.kind === 'bidi') {
      call.write = (chunk: unknown, ...rest: unknown[]) => {
        exchange.requests.push(this.placeholders.json(chunk));
        return write(chunk, ...rest);
      };
    }
    call.on('status', (status) => {
      const trailers = Object.keys(status.metadata?.getMap() ?? {}).sort();
      exchange.status = { code: status.code, details: status.details, trailers };
    });
  }
}

// ─── https.request ────────────────────────────────────────────────────────

export type HttpService = 'auth' | 'certs' | 'storage';

export type HttpBody =
  | { kind: 'json'; json: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; length: number; sha256: string }
  /** The cert fetch: the key ids are per-rotation and the bodies are never kept. */
  | { kind: 'certs'; keyCount: number };

export interface HttpExchange {
  seq: number;
  t: number;
  op: string;
  service: HttpService;
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  request: { headerNames: string[]; contentType: string | null; body: HttpBody | null };
  response: { status: number; headerNames: string[]; headers: Record<string, string>; body: HttpBody | null };
}

/** The hosts recorded; every other host, token sources among them, is never recorded. */
export function httpService(host: string, path: string): HttpService | null {
  if (host === 'identitytoolkit.googleapis.com') return 'auth';
  if (host === 'storage.googleapis.com') return 'storage';
  if (host === 'www.googleapis.com' && path.startsWith('/robot/v1/metadata/x509/')) return 'certs';
  return null;
}

/** Response header values kept; every other header keeps only its name. */
const KEPT_RESPONSE_HEADERS = new Set(['content-type', 'cache-control']);

function decoded(bytes: Buffer, encoding: string | undefined): Buffer {
  if (encoding === 'gzip') return gunzipSync(bytes);
  if (encoding === 'deflate') return inflateSync(bytes);
  if (encoding === 'br') return brotliDecompressSync(bytes);
  return bytes;
}

type HttpsModule = { request: (...args: unknown[]) => ClientRequest };

/** The CommonJS `https` module object, the one firebase-admin and node-fetch call through. */
export function httpsModule(): HttpsModule {
  return createRequire(import.meta.url)('node:https') as HttpsModule;
}

export class HttpRecorder {
  readonly exchanges: HttpExchange[] = [];
  private readonly pending: Array<Promise<void>> = [];
  private readonly stamp: Stamp;
  private readonly placeholders: Placeholders;

  constructor(stamp: Stamp, placeholders: Placeholders) {
    this.stamp = stamp;
    this.placeholders = placeholders;
  }

  /** Wraps `https.request`; every request is sent unchanged. Returns the uninstall. */
  install(https: HttpsModule = httpsModule()): () => void {
    const real = https.request;
    const recorder = this;
    https.request = function (this: unknown, ...args: unknown[]): ClientRequest {
      const request = real.apply(this, args);
      if (!recorder.stamp.paused) recorder.track(request);
      return request;
    };
    return () => { https.request = real; };
  }

  /** Waits for every response body still being read. */
  async settled(): Promise<void> {
    while (this.pending.length > 0) await Promise.all(this.pending.splice(0));
  }

  private track(request: ClientRequest): void {
    const url = new URL(request.path, `https://${request.host}`);
    const service = httpService(url.hostname, url.pathname);
    if (service === null) return;
    const exchange: HttpExchange = {
      seq: this.exchanges.length + 1,
      t: this.stamp.now(),
      op: this.stamp.op,
      service,
      method: request.method,
      host: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      request: { headerNames: [], contentType: null, body: null },
      response: { status: 0, headerNames: [], headers: {}, body: null },
    };
    this.exchanges.push(exchange);
    const sent: Buffer[] = [];
    const write = request.write.bind(request) as (chunk: unknown, ...rest: unknown[]) => boolean;
    request.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string' || chunk instanceof Uint8Array) sent.push(Buffer.from(chunk as string));
      return write(chunk, ...rest);
    }) as ClientRequest['write'];
    const end = request.end.bind(request) as (...rest: unknown[]) => ClientRequest;
    request.end = ((...rest: unknown[]) => {
      const chunk = rest[0];
      if (typeof chunk === 'string' || chunk instanceof Uint8Array) sent.push(Buffer.from(chunk as string));
      const headers = request.getHeaders();
      const contentType = headers['content-type'];
      exchange.request.headerNames = Object.keys(headers).sort();
      exchange.request.contentType = contentType === undefined ? null : String(contentType);
      exchange.request.body = this.body(Buffer.concat(sent), exchange.request.contentType, service);
      return end(...rest);
    }) as ClientRequest['end'];
    this.pending.push(new Promise((resolve) => {
      request.once('error', () => resolve());
      request.once('response', (response: IncomingMessage) => {
        const received: Buffer[] = [];
        exchange.response.status = response.statusCode ?? 0;
        exchange.response.headerNames = Object.keys(response.headers).sort();
        for (const name of KEPT_RESPONSE_HEADERS) {
          const value = response.headers[name];
          if (typeof value === 'string') exchange.response.headers[name] = value;
        }
        response.on('data', (chunk: Buffer) => received.push(chunk));
        response.once('close', () => {
          const bytes = decoded(Buffer.concat(received), response.headers['content-encoding']);
          exchange.response.body = this.body(bytes, exchange.response.headers['content-type'] ?? null, service);
          resolve();
        });
      });
    }));
  }

  private body(bytes: Buffer, contentType: string | null, service: HttpService): HttpBody | null {
    if (bytes.length === 0) return null;
    const text = bytes.toString('utf8');
    if (service === 'certs') return { kind: 'certs', keyCount: Object.keys(JSON.parse(text) as object).length };
    if (/json/.test(contentType ?? '')) {
      try {
        return { kind: 'json', json: this.placeholders.json(JSON.parse(text)) };
      } catch {
        return { kind: 'text', text };
      }
    }
    if (/^text\/|multipart\//.test(contentType ?? '')) return { kind: 'text', text: text.replace(/boundary=[^\s;"]+|--[0-9a-f-]{16,}/g, '<boundary>') };
    return { kind: 'bytes', length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}

// ─── RTDB data messages ───────────────────────────────────────────────────

export interface RtdbMessage {
  t: number;
  op: string;
  dir: 'sent' | 'received';
  /** The data message as the frame carries it in `{"t":"d","d":...}`. */
  message: unknown;
}

/** The actions whose body carries a credential: the request body and its answer's data are dropped. */
const CREDENTIAL_ACTIONS = new Set(['gauth', 'auth', 'appcheck']);

interface PersistentConnection {
  realtime_: unknown;
  sendRequest(action: string, body: unknown, onResponse?: (message: unknown) => void): void;
  onDataMessage_(message: Record<string, unknown>): void;
}

/**
 * The persistent connection behind a firebase-admin `Database`. Reading
 * `_delegate._repo` starts the repo, which creates the connection and
 * schedules its connect on a timer, so the recorder is in place before the
 * first frame.
 */
export function persistentConnectionOf(database: unknown): PersistentConnection {
  const repo = (database as { _delegate: { _repo: { persistentConnection_: PersistentConnection | null } } })._delegate._repo;
  const connection = repo.persistentConnection_;
  if (connection === null) throw new Error('the database has no persistent connection');
  if (connection.realtime_ !== null) throw new Error('the database connected before the recorder was in place');
  return connection;
}

export class RtdbRecorder {
  readonly messages: RtdbMessage[] = [];
  private readonly credentialRequests = new Set<unknown>();
  private readonly stamp: Stamp;

  constructor(stamp: Stamp) {
    this.stamp = stamp;
  }

  /** Wraps the connection class's send and receive; returns the uninstall. */
  install(connection: PersistentConnection): () => void {
    const proto = Object.getPrototypeOf(connection) as PersistentConnection;
    const { sendRequest, onDataMessage_: onDataMessage } = proto;
    const recorder = this;
    proto.sendRequest = function (this: PersistentConnection & { requestNumber_: number }, action, body, onResponse) {
      const r = this.requestNumber_ + 1;
      if (CREDENTIAL_ACTIONS.has(action)) recorder.credentialRequests.add(r);
      const kept = CREDENTIAL_ACTIONS.has(action) ? '<dropped>' : body;
      recorder.record('sent', { r, a: action, b: kept });
      sendRequest.call(this, action, body, onResponse);
    };
    proto.onDataMessage_ = function (this: PersistentConnection, message) {
      recorder.record('received', recorder.credentialRequests.has(message.r) ? recorder.dropAnswer(message) : message);
      onDataMessage.call(this, message);
    };
    return () => Object.assign(proto, { sendRequest, onDataMessage_: onDataMessage });
  }

  private dropAnswer(message: Record<string, unknown>): Record<string, unknown> {
    const body = (message.b ?? {}) as { s?: unknown };
    return { r: message.r, b: { s: body.s, d: '<dropped>' } };
  }

  private record(dir: RtdbMessage['dir'], message: unknown): void {
    if (this.stamp.paused) return;
    this.messages.push({ t: this.stamp.now(), op: this.stamp.op, dir, message: JSON.parse(JSON.stringify(message)) as unknown });
  }
}

// ─── Run cleanup ──────────────────────────────────────────────────────────

/**
 * What one run can leave in production, reached through the script's own
 * Admin clients. Each `list` or `find` is the read-back.
 */
export interface AdminRunState {
  users: {
    /** The uid of the user with this email, or null when there is none. */
    find(email: string): Promise<string | null>;
    remove(uid: string): Promise<void>;
  };
  documents: {
    /** Every document path under the run document, at any depth. */
    list(runPath: string): Promise<string[]>;
    remove(path: string): Promise<void>;
  };
  rtdb: {
    /** The value at the path, null when there is none. */
    read(path: string): Promise<unknown>;
    remove(path: string): Promise<void>;
  };
  objects: {
    /** Every object name under the prefix. */
    list(prefix: string): Promise<string[]>;
    remove(name: string): Promise<void>;
  };
}

export interface AdminRun {
  runId: string;
}

export interface AdminInvariants {
  /** The run's user was looked up after cleanup and was not found. */
  userDeleted: boolean;
  /** The run's documents were listed after cleanup and none was left. */
  documentsRemoved: boolean;
  /** The run's RTDB path read back as null. */
  rtdbRemoved: boolean;
  /** The run's Storage prefix listed back empty. */
  objectsRemoved: boolean;
}

export interface AdminCleanupOptions {
  /** Stops anything still running (a listener, an app) before the state is read. */
  quiesce?: () => Promise<void>;
  /** Install SIGINT and SIGTERM handlers that run the same cleanup once, then exit. */
  handleSignals?: boolean;
}

export interface AdminRunResult<T> {
  result?: T;
  error?: Error;
  invariants: AdminInvariants;
  failures: string[];
}

export function allHeld(invariants: AdminInvariants): boolean {
  return invariants.userDeleted && invariants.documentsRemoved && invariants.rtdbRemoved && invariants.objectsRemoved;
}

async function attempt<T>(failures: string[], step: string, task: () => Promise<T>): Promise<{ value: T } | null> {
  try {
    return { value: await task() };
  } catch (e) {
    failures.push(`${step}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function removeAll(failures: string[], what: string, names: readonly string[], remove: (name: string) => Promise<void>): Promise<void> {
  for (const name of names) await attempt(failures, `remove ${what} ${name}`, () => remove(name));
}

/**
 * The cleanup after a run, and all of `--cleanup <run id>`. Every step runs
 * whatever the earlier ones did: a failed delete still reads the others back.
 * A failed step is an invariant failure, never a throw.
 */
export async function cleanupAdminRun(
  label: string,
  state: AdminRunState,
  run: AdminRun,
  options: Pick<AdminCleanupOptions, 'quiesce'> = {},
): Promise<{ invariants: AdminInvariants; failures: string[] }> {
  const failures: string[] = [];
  const runPath = runPathFor(run.runId);
  const email = userEmailFor(run.runId);
  if (options.quiesce) await attempt(failures, 'quiesce', options.quiesce);

  const uid = await attempt(failures, 'find user', () => state.users.find(email));
  if (uid?.value) await attempt(failures, 'remove user', () => state.users.remove(uid.value!));
  const userBack = await attempt(failures, 'read user back', () => state.users.find(email));

  const documents = await attempt(failures, 'list documents', () => state.documents.list(runPath));
  await removeAll(failures, 'document', documents?.value ?? [], (path) => state.documents.remove(path));
  const documentsBack = await attempt(failures, 'read documents back', () => state.documents.list(runPath));

  await attempt(failures, 'remove rtdb path', () => state.rtdb.remove(runPath));
  const rtdbBack = await attempt(failures, 'read rtdb path back', () => state.rtdb.read(runPath));

  const objects = await attempt(failures, 'list objects', () => state.objects.list(`${runPath}/`));
  await removeAll(failures, 'object', objects?.value ?? [], (name) => state.objects.remove(name));
  const objectsBack = await attempt(failures, 'read objects back', () => state.objects.list(`${runPath}/`));

  const invariants: AdminInvariants = {
    userDeleted: userBack !== null && userBack.value === null,
    documentsRemoved: documentsBack !== null && documentsBack.value.length === 0,
    rtdbRemoved: rtdbBack !== null && rtdbBack.value === null,
    objectsRemoved: objectsBack !== null && objectsBack.value.length === 0,
  };
  if (!allHeld(invariants) || failures.length > 0) {
    console.error(`[capture-admin] ${label}: invariant failed`, invariants, { failures });
    console.error(`[capture-admin] ${label}: run --cleanup ${run.runId}, or read the user, documents, RTDB path and objects back by hand.`);
  }
  return { invariants, failures };
}

/** What the run already holds before it starts; a run id is never reused. */
async function leftovers(state: AdminRunState, run: AdminRun): Promise<string[]> {
  const runPath = runPathFor(run.runId);
  const found: string[] = [];
  if ((await state.users.find(userEmailFor(run.runId))) !== null) found.push('the user');
  if ((await state.documents.list(runPath)).length > 0) found.push('documents');
  if ((await state.rtdb.read(runPath)) !== null) found.push('RTDB data');
  if ((await state.objects.list(`${runPath}/`)).length > 0) found.push('objects');
  return found;
}

/**
 * Refuse a run that already holds anything, run `body`, then remove the
 * run's user, documents, RTDB path and objects and read each back. The
 * invariants are reported whether or not `body` threw.
 */
export async function runWithAdminCleanup<T>(
  label: string,
  state: AdminRunState,
  run: AdminRun,
  body: () => Promise<T>,
  options: AdminCleanupOptions = {},
): Promise<AdminRunResult<T>> {
  const found = await leftovers(state, run);
  if (found.length > 0) throw new Error(`${label}: refusing: run ${run.runId} already holds ${found.join(', ')}`);

  let cleanup: Promise<{ invariants: AdminInvariants; failures: string[] }> | undefined;
  const cleanupOnce = () => (cleanup ??= cleanupAdminRun(label, state, run, options));
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`[capture-admin] ${label}: ${signal}; cleaning up before exit.`);
    void cleanupOnce().then(({ invariants }) => process.exit(allHeld(invariants) ? 130 : 3));
  };
  if (options.handleSignals) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  let result: T | undefined;
  let error: Error | undefined;
  try {
    result = await body();
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  const { invariants, failures } = await cleanupOnce();
  if (options.handleSignals) {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return { result, error, invariants, failures };
}
