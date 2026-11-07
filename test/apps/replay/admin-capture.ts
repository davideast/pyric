// Capture A (Admin) (`packages/conformance/src/capture/admin-live/recordings/capture-admin-wire.json`)
// as replay exchanges, converted when a replay server loads it, so no copied
// fixture can drift from what production sent to firebase-admin.
//
// Each gRPC call becomes an `admin-firestore` exchange, each Auth call an
// `admin-auth` one, each Storage call an `admin-storage` one at the path the
// SDK uses under `STORAGE_EMULATOR_HOST` (no `/storage/v1` prefix on object
// calls), and each RTDB request with its reply an `rtdb` one as `owner`. A
// data push becomes an event of the request whose reply came next, so it goes
// out in the order production sent it. The cert fetch becomes the user
// lookup firebase-admin sends in its place under `FIREBASE_AUTH_EMULATOR_HOST`.
//
// Values: `<project>` becomes the project, `<run>` `replay`, `<bucket>` the
// project's default bucket, `<email>` and `<uid-N>` test values, and an
// object's hashes the real hashes of its recorded bytes. Commit and
// read times, resume tokens and transaction ids become the replay's
// placeholders, and a transaction that no request names (an empty one, as a
// read outside a transaction carries) is dropped. Document times, Storage
// object fields and Auth times become fixed test values; a `validSince` first
// seen after a revoke lies past any token a test mints, so revocation answers
// as recorded. A request's password and `validSince` match any value, each
// push key an RTDB client picked is a `pushId` placeholder, and the document
// `add` created is an `autoId` placeholder, so an app's own id is kept.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AdminStorageExchange } from './admin-storage.ts';
import { targetShape } from './firestore.ts';
import {
  assertShapesOnly,
  FORMAT,
  type AdminAuthExchange,
  type AdminFirestoreExchange,
  type AdminFirestoreRpc,
  type Json,
  type JsonObject,
  type ListenBatch,
  type Recording,
  type RtdbExchange,
} from './format.ts';

export const CAPTURE_ADMIN = fileURLToPath(new URL('../../../packages/conformance/src/capture/admin-live/recordings/capture-admin-wire.json', import.meta.url));
/** What the capture's `<run>` becomes: every path it wrote sits under `pyric_oracle/<run>`. */
export const ADMIN_CAPTURE_RUN = 'replay';
/** What the capture's `<email>` becomes. */
export const ADMIN_CAPTURE_EMAIL = 'admin-capture@example.com';

interface GrpcCall {
  seq: number;
  op: string;
  kind: 'unary' | 'server-stream' | 'bidi';
  method: string;
  requests: JsonObject[];
  responses: Array<{ t: number; message: JsonObject }>;
  status: { code: number; details: string };
}

type HttpBody = { kind: 'json'; json: JsonObject } | { kind: 'text'; text: string } | { kind: 'certs' } | null;

interface HttpCall {
  seq: number;
  service: 'auth' | 'certs' | 'storage';
  method: string;
  path: string;
  query: JsonObject;
  request: { contentType: string | null; body: HttpBody };
  response: { status: number; headers: JsonObject; body: HttpBody };
}

interface RtdbMessage {
  dir: 'sent' | 'received';
  message: JsonObject;
}

interface AdminCapture {
  observedAt: string;
  adminVersion: string;
  grpc: GrpcCall[];
  http: HttpCall[];
  rtdb: RtdbMessage[];
}

/** The capture with its project, run, bucket, user and fixed-value placeholders as test values. */
export function readAdminCapture(project: string, path: string = CAPTURE_ADMIN): AdminCapture {
  return adminCaptureFromText(project, readFileSync(path, 'utf8'));
}

/** A capture's text with its placeholders as test values for `project`. */
export function adminCaptureFromText(project: string, raw: string): AdminCapture {
  const hashes = objectHashes(JSON.parse(raw) as AdminCapture);
  const text = raw
    .replaceAll('<project>', project)
    .replaceAll('<run>', ADMIN_CAPTURE_RUN)
    .replaceAll('<bucket>', `${project}.firebasestorage.app`)
    .replaceAll('<email>', ADMIN_CAPTURE_EMAIL)
    .replace(/<uid-(\d+)>/g, (_, n: string) => `user-${n}`)
    .replace(/<(update|create)-time-(\d+)>/g, (_, kind: string, n: string) => fixedTime(kind === 'create' ? 2 * Number(n) - 1 : 2 * Number(n)))
    .replace(/<time-(\d+)>/g, (_, n: string) => fixedTime(Number(n)).replace(/\.\d+Z$/, '.000Z'))
    .replace(/<generation-(\d+)>/g, (_, n: string) => `179352000000000${n}`)
    .replace(/<(md5|crc32c)-\d+>/g, (placeholder: string) => hashOf(hashes, placeholder))
    .replace(/<password-hash-(\d+)>/g, (_, n: string) => Buffer.from(`replay-password-hash-${n}`).toString('base64'))
    .replace(/<etag-(\d+)>/g, (_, n: string) => `replay-etag-${n}`);
  return JSON.parse(text) as AdminCapture;
}

/** Capture A (Admin) as a replay recording for `project`, checked like any recording. */
export function loadCaptureAdmin(project: string, path: string = CAPTURE_ADMIN): Recording {
  const capture = readAdminCapture(project, path);
  const recording: Recording = {
    format: FORMAT,
    project,
    source: `capture A (Admin), observed ${capture.observedAt} with firebase-admin ${capture.adminVersion}`,
    exchanges: [
      ...firestoreExchanges(capture.grpc),
      ...authExchanges(capture.http.filter((call) => call.service !== 'storage')),
      ...capture.http.filter((call) => call.service === 'storage').map(storageExchange),
      ...rtdbExchanges(capture.rtdb, `${project}-default-rtdb`),
    ],
  };
  assertShapesOnly(recording);
  return recording;
}

/** 2026-11-01T08:00:00Z plus `seconds`, as Firestore writes a time. */
function fixedTime(seconds: number): string {
  return new Date(Date.UTC(2026, 10, 1, 8, 0, seconds)).toISOString().replace(/\.\d{3}Z$/, '.000001Z');
}

// ─── Firestore ────────────────────────────────────────────────────────────

const GRPC_STATUS: Record<number, string> = { 1: 'CANCELLED', 3: 'INVALID_ARGUMENT', 5: 'NOT_FOUND', 6: 'ALREADY_EXISTS', 7: 'PERMISSION_DENIED', 9: 'FAILED_PRECONDITION', 10: 'ABORTED' };
const PLACEHOLDER_OF: Record<string, string> = { 'commit-time': 'commitTime', 'read-time': 'readTime', 'resume-token': 'resumeToken' };
const CAPTURE_PLACEHOLDER = /^<([a-z-]+)-\d+>$/;

function firestoreExchanges(calls: GrpcCall[]): AdminFirestoreExchange[] {
  const named = new Set(calls.flatMap((call) => call.requests.map((request) => request.transaction)).filter((value): value is string => typeof value === 'string'));
  const commits = calls
    .filter((call) => rpcOf(call) === 'Commit' && call.responses.length > 0)
    .map((call) => ({ id: firestoreId(call), at: call.responses[0]!.t }));
  const exchanges = calls.map((call) => (call.kind === 'bidi' ? listenExchange(call, named, commits) : callExchange(call, named)));
  const added = addedDocument(calls);
  return added === null ? exchanges : exchanges.map((exchange) => withAutoId(exchange, added));
}

/** The name of the document `add` created, or null when the capture has no `add`. */
function addedDocument(calls: GrpcCall[]): string | null {
  const add = calls.find((call) => call.op === 'firestore.add');
  const write = (add?.requests[0]?.writes as JsonObject[] | undefined)?.[0];
  const name = (write?.update as JsonObject | undefined)?.name;
  return typeof name === 'string' ? name : null;
}

/** `exchange` with each mention of the added document as the `autoId` placeholder `add-1`. */
function withAutoId(exchange: AdminFirestoreExchange, added: string): AdminFirestoreExchange {
  const parent = added.slice(0, added.lastIndexOf('/'));
  const placeholder: JsonObject = { $: 'autoId', name: 'add-1', parent };
  const convert = (value: Json): Json => (value === added ? placeholder : mapJson(value, convert));
  const converted = convert(exchange as unknown as Json) as unknown as AdminFirestoreExchange;
  const id = added.slice(added.lastIndexOf('/') + 1);
  if (JSON.stringify(converted).includes(id)) throw new Error(`replay: capture A names the added document ${id} outside a document name`);
  return converted;
}

function rpcOf(call: GrpcCall): AdminFirestoreRpc {
  return call.method.slice(call.method.lastIndexOf('/') + 1) as AdminFirestoreRpc;
}

function firestoreId(call: GrpcCall): string {
  return `admin-firestore-${call.seq}`;
}

function callExchange(call: GrpcCall, named: Set<string>): AdminFirestoreExchange {
  const exchange: AdminFirestoreExchange = {
    kind: 'admin-firestore',
    id: firestoreId(call),
    rpc: rpcOf(call),
    request: firestoreRequest(call.requests[0]!) as JsonObject,
    responses: call.responses.map((response) => firestoreAnswer(response.message, named) as JsonObject),
  };
  if (call.status.code !== 0) exchange.error = { code: call.status.code, status: GRPC_STATUS[call.status.code] ?? 'UNKNOWN', message: call.status.details };
  return exchange;
}

/**
 * A Listen: the first batch is every message before a Commit answered while
 * the stream was open, and each later batch is released by the Commit whose
 * answer came last before it.
 */
function listenExchange(call: GrpcCall, named: Set<string>, commits: Array<{ id: string; at: number }>): AdminFirestoreExchange {
  const opened = call.responses[0]?.t ?? 0;
  const batches: ListenBatch[] = [{ messages: [] }];
  for (const response of call.responses) {
    const after = commits.filter((commit) => commit.at > opened && commit.at < response.t).at(-1)?.id;
    let batch = batches.find((candidate) => candidate.after === after);
    if (!batch) {
      batch = { after, messages: [] };
      batches.push(batch);
    }
    batch.messages.push(firestoreAnswer(response.message, named) as JsonObject);
  }
  const addTarget = firestoreRequest(call.requests[0]!.addTarget as JsonObject) as JsonObject;
  return { kind: 'admin-firestore', id: firestoreId(call), rpc: 'Listen', request: targetShape(addTarget), batches };
}

/** A request as the replay decodes one: integers as strings, and a transaction the server issued. */
function firestoreRequest(value: Json, key = ''): Json {
  if (key === 'integerValue' && typeof value === 'number') return String(value);
  if (key === 'transaction' && typeof value === 'string') return { $: 'transaction' };
  return mapJson(value, firestoreRequest);
}

/** An answer with the replay's placeholders, and no null or empty-transaction field. */
function firestoreAnswer(value: Json, named: Set<string>, key = ''): Json | undefined {
  if (value === null) return undefined;
  if (key === 'transaction' && typeof value === 'string') return named.has(value) ? { $: 'transaction' } : undefined;
  if (key === 'targetIds' && Array.isArray(value)) return value.map(() => ({ $: 'targetId' }));
  if (key === 'targetId' && typeof value === 'number') return { $: 'targetId' };
  const placeholder = typeof value === 'string' ? PLACEHOLDER_OF[CAPTURE_PLACEHOLDER.exec(value)?.[1] ?? ''] : undefined;
  if (placeholder) return { $: placeholder };
  return mapJson(value, (item, itemKey) => firestoreAnswer(item, named, itemKey));
}

/** A copy of `value` with each array item and object field converted, dropping fields that convert to undefined. */
function mapJson(value: Json, convert: (item: Json, key: string) => Json | undefined): Json {
  if (Array.isArray(value)) return value.map((item) => convert(item, '') ?? null);
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return value;
  const entries = Object.entries(value).map(([key, item]) => [key, convert(item, key)] as const);
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, Json] => entry[1] !== undefined));
}

// ─── Auth ─────────────────────────────────────────────────────────────────

const PAST_SECONDS = 1_793_520_000;
const FUTURE_SECONDS = 4_102_444_800;
const ANY: JsonObject = { $: 'any' };

/** Auth times by placeholder, in the order the calls carried them: a `validSince` first seen after a revoke is in the future. */
class AuthTimes {
  private readonly times = new Map<string, string>();
  revoked = false;

  value(placeholder: string, key: string): Json {
    const known = this.times.get(placeholder);
    if (known !== undefined) return key === 'passwordUpdatedAt' ? Number(known) : known;
    const seconds = key === 'validSince' && this.revoked ? FUTURE_SECONDS : PAST_SECONDS;
    const time = authTime(key, seconds);
    this.times.set(placeholder, time);
    return key === 'passwordUpdatedAt' ? Number(time) : time;
  }
}

function authTime(key: string, seconds: number): string {
  if (key === 'validSince') return String(seconds);
  if (key === 'lastRefreshAt') return new Date(seconds * 1000).toISOString();
  return String(seconds * 1000);
}

/**
 * Every Auth call, in order. Under `FIREBASE_AUTH_EMULATOR_HOST`,
 * firebase-admin looks the user up on every `verifyIdToken` where production
 * fetched the signing certs instead, so a cert fetch becomes that lookup,
 * answered as the next recorded lookup was.
 */
function authExchanges(calls: HttpCall[]): AdminAuthExchange[] {
  const times = new AuthTimes();
  return calls.map((call, index) => {
    const isCertFetch = call.service === 'certs';
    const lookup = isCertFetch ? calls.slice(index).find((later) => later.path.endsWith('/accounts:lookup')) : undefined;
    if (!lookup) return authExchange(call, times);
    return { ...authExchange(lookup, times), id: `admin-auth-${call.seq}` };
  });
}

function authExchange(call: HttpCall, times: AuthTimes): AdminAuthExchange {
  const body = call.request.body?.kind === 'json' ? authRequest(call.request.body.json) as JsonObject : undefined;
  if (body && 'validSince' in body) times.revoked = true;
  const answer = call.response.body?.kind === 'json' ? authAnswer(call.response.body.json, times) as JsonObject : {};
  const hasQuery = Object.keys(call.query).length > 0;
  return {
    kind: 'admin-auth',
    id: `admin-auth-${call.seq}`,
    request: { method: call.method, path: call.path, ...(hasQuery ? { query: call.query } : {}), ...(body ? { body } : {}) },
    response: { status: call.response.status, body: answer },
  };
}

/** A request body where the password and a revoke's `validSince`, which the SDK picks, match any value. */
function authRequest(value: Json, key = ''): Json {
  if (key === 'password' || key === 'validSince') return ANY;
  return mapJson(value, authRequest);
}

function authAnswer(value: Json, times: AuthTimes, key = ''): Json {
  const isAuthTime = typeof value === 'string' && /^<auth-time-\d+>$/.test(value);
  if (isAuthTime) return times.value(value as string, key);
  return mapJson(value, (item, itemKey) => authAnswer(item, times, itemKey));
}

// ─── Storage ──────────────────────────────────────────────────────────────

function storageExchange(call: HttpCall): AdminStorageExchange {
  return {
    kind: 'admin-storage',
    id: `admin-storage-${call.seq}`,
    request: {
      method: call.method,
      path: call.path.replace(/^\/storage\/v1\/b\//, '/b/'),
      query: call.query,
      ...uploadContent(call.request.contentType, call.request.body),
    },
    response: { status: call.response.status, headers: call.response.headers, body: storageAnswer(call.response.body) },
  };
}

/** The metadata JSON and object bytes a request sent: a multipart upload's two parts, or a JSON body. */
function uploadContent(contentType: string | null, body: HttpBody): Pick<AdminStorageExchange['request'], 'metadata' | 'bytes'> {
  if (body?.kind === 'json') return { metadata: body.json };
  const parts = multipartParts(contentType, body);
  if (!parts) return {};
  return { metadata: parts.metadata, bytes: { length: parts.content.length, sha256: createHash('sha256').update(parts.content).digest('hex') } };
}

/** A multipart upload's metadata and object bytes, or null for another body. */
function multipartParts(contentType: string | null, body: HttpBody): { metadata: JsonObject; content: Buffer } | null {
  const isMultipart = body?.kind === 'text' && (contentType ?? '').startsWith('multipart/related');
  if (!isMultipart) return null;
  const [metadata, content] = body.text.split('<boundary>').slice(1, -1).map((part) => part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''));
  return { metadata: JSON.parse(metadata ?? '{}') as JsonObject, content: Buffer.from(content ?? '', 'utf8') };
}

/**
 * Each uploaded object's MD5 and CRC32C, by the placeholders its upload's
 * answer carries. The SDK checks them against the bytes it sent, so they are
 * the real hashes of the recorded bytes.
 */
function objectHashes(capture: AdminCapture): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const call of capture.http) {
    const parts = multipartParts(call.request.contentType, call.request.body);
    const answer = call.response.body?.kind === 'json' ? call.response.body.json : null;
    if (!parts || !answer) continue;
    hashes.set(String(answer.md5Hash), createHash('md5').update(parts.content).digest('base64'));
    hashes.set(String(answer.crc32c), crc32c(parts.content));
  }
  return hashes;
}

/**
 * The hash a placeholder stands for. One no recorded upload hashes would
 * otherwise become an empty hash the SDK checks a download against, so it
 * throws instead.
 */
function hashOf(hashes: Map<string, string>, placeholder: string): string {
  const hash = hashes.get(placeholder);
  if (hash === undefined) throw new Error(`replay: capture A (Admin) names ${placeholder}, which no recorded multipart upload hashes`);
  return hash;
}

/** CRC32C (Castagnoli), big-endian and base64, as Cloud Storage reports it. */
function crc32c(bytes: Buffer): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return out.toString('base64');
}

/** An answer body: JSON as sent, and text as the bytes the replay serves. */
function storageAnswer(body: HttpBody): Json {
  if (body?.kind === 'json') return body.json;
  if (body?.kind === 'text') return { $media: Buffer.from(body.text, 'utf8').toString('base64') };
  return null;
}

// ─── RTDB ─────────────────────────────────────────────────────────────────

/** Requests the replay answers itself (`rtdb.ts`): unlisten and stats. */
const SERVER_ANSWERED = new Set(['n', 's']);

function rtdbExchanges(messages: RtdbMessage[], instance: string): RtdbExchange[] {
  const handshake: RtdbExchange = { kind: 'rtdb', id: 'admin-rtdb-connect', instance, events: [{ t: 'c', d: { t: 'h', d: { ts: { $: 'serverTime' }, v: '5', h: { $: 'host' }, s: { $: 'session' } } } }] };
  const exchanges: RtdbExchange[] = [handshake];
  const pending = new Map<number, RtdbExchange>();
  let pushes: JsonObject[] = [];
  for (const { dir, message } of messages) {
    const r = typeof message.r === 'number' ? message.r : null;
    if (dir === 'sent') {
      if (r === null || SERVER_ANSWERED.has(String(message.a))) continue;
      const exchange: RtdbExchange = { kind: 'rtdb', id: `admin-rtdb-${r}`, instance, as: 'owner', request: { a: String(message.a), b: rtdbRequest(message.b ?? null) } };
      pending.set(r, exchange);
      exchanges.push(exchange);
      continue;
    }
    if (r === null) {
      pushes.push({ t: 'd', d: message });
      continue;
    }
    const exchange = pending.get(r);
    if (!exchange) continue;
    pending.delete(r);
    exchange.reply = message.b as { s: string; d: Json };
    if (pushes.length > 0) exchange.events = pushes;
    pushes = [];
  }
  return exchanges;
}

/** A request body where a push key the client picked is a `pushId` placeholder. */
function rtdbRequest(body: Json): Json {
  const path = (body as JsonObject | null)?.p;
  const pushed = typeof path === 'string' ? /^(.*)\/<push-id-(\d+)>$/.exec(path) : null;
  if (!pushed) return body;
  return { ...(body as JsonObject), p: { $: 'pushId', name: `push-${pushed[2]}`, parent: pushed[1]! } };
}
