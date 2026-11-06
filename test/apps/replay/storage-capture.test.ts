/**
 * Capture S replays end to end, in a process: a replay server process
 * (`startReplayProcess` with `storageCapture`) serves capture S as
 * `storage-capture.ts` converts it, and the Node build of the real
 * `firebase/storage` SDK runs the capture's whole sequence against it, on the
 * default bucket and on the second one. Two clients sign in, a third never
 * does. The sequence uploads with uploadBytes, uploadString (raw and base64)
 * and uploadBytesResumable, pauses and resumes a second resumable upload,
 * reads metadata, a download URL, the bytes and a stream, updates metadata,
 * lists with `maxResults: 2` and its `pageToken`, lists a nested prefix with
 * listAll, reads as the second account, deletes every object, misses a
 * missing object, and is denied an upload, a read and a list, and an upload
 * signed out.
 *
 * Every Storage answer the SDK got must equal capture S's answer to the same
 * call, apart from the values a server picks (generations, times, download
 * tokens, upload ids, page tokens) and the bucket, and the server must list
 * nothing in `unmatched`. The app code is plain SDK code: it points Auth and
 * Storage at the server with the emulator connectors.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/storage-capture.test.ts'`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FirebaseStorage, StorageReference } from 'firebase/storage';
import { FORMAT, type AuthExchange, type Json, type JsonObject, type Recording } from './format.ts';
import { receivedBy, startReplayProcess, unmatchedBy, type ReplayProcess } from './process.ts';
import { routeFirebaseTo } from './seam.ts';
import { CAPTURE_S_ETAG, CAPTURE_S_RUN, captureSBuckets, readCaptureS, type CaptureBody, type CaptureS, type CaptureSExchange } from './storage-capture.ts';
import type { StorageReceived } from './storage.ts';

const PROJECT = 'demo-storage-s';
const BUCKETS = captureSBuckets(PROJECT);
const CONFIG = { projectId: PROJECT, apiKey: 'test-api-key', appId: '1:1:web:replay-storage-s', storageBucket: BUCKETS.default };
const RUN_PATH = `pyric_oracle/${CAPTURE_S_RUN}`;
const DENIED_PATH = `pyric_oracle_denied_storage/${CAPTURE_S_RUN}`;
/** The bytes capture S uploaded, as its script makes them. */
const SIX_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6]);
const RESUMABLE_BYTES = Uint8Array.from({ length: 600 * 1024 }, (_, i) => i % 251);
const OBJECTS = ['a.bin', 'raw.txt', 'b64.bin', 'big.bin', 'paused.bin', 'nested/x/one.txt', 'nested/two.txt'];
const TIMEOUT_MS = 60_000;

type FirebaseApp = typeof import('firebase/app');
type FirebaseAuth = typeof import('firebase/auth');
type FirebaseStorageSdk = typeof import('firebase/storage');

/** `@firebase/storage`'s Node ESM build, the one a server runs, found next to the build `firebase/storage` resolves to. */
function storageNodeEntry(): string {
  const firebaseStorage = createRequire(import.meta.url).resolve('firebase/storage');
  const entry = createRequire(firebaseStorage).resolve('@firebase/storage');
  return join(dirname(entry), 'node-esm', 'index.node.esm.js');
}

/** Custom-token sign-ins: `client-N` gets an anonymous ID token for `user-N`, the uid capture S's `<uid-N>` becomes. */
function signIns(count: number): Recording {
  const exchanges: AuthExchange[] = [];
  for (let n = 1; n <= count; n++) {
    const uid = `user-${n}`;
    exchanges.push({
      kind: 'auth',
      id: `sign-in-${n}`,
      request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:signInWithCustomToken', body: { token: `client-${n}`, returnSecureToken: true } },
      response: { status: 200, body: { kind: 'identitytoolkit#VerifyCustomTokenResponse', idToken: { $: 'idToken', uid, provider: 'anonymous' }, refreshToken: { $: 'refreshToken' }, expiresIn: '3600', isNewUser: true } },
    });
    exchanges.push({
      kind: 'auth',
      id: `lookup-${n}`,
      request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:lookup', body: { idToken: { $: 'idToken', uid } } },
      response: { status: 200, body: { kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: uid, lastLoginAt: '1793937599013', createdAt: '1793937599013' }] } },
    });
  }
  return { format: FORMAT, project: PROJECT, source: 'hand-written from the Auth REST v1 wire format', exchanges };
}

/** One Storage answer the SDK got, read off `fetch`. */
interface SeenAnswer {
  method: string;
  url: URL;
  status: number;
  headers: Headers;
  body: Buffer;
}

let server: ReplayProcess;
let scratch: string;
let stopRouting: () => void;
let restoreFetch: () => void;
let firebase: FirebaseApp;
let auth: FirebaseAuth;
let storage: FirebaseStorageSdk;
let capture: CaptureS;
const seen: SeenAnswer[] = [];

/** Wraps `fetch` so every Storage answer the SDK reads is kept, its body read from a copy. */
function recordStorageAnswers(): () => void {
  const inner = globalThis.fetch;
  const recording = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const response = await inner(input, init);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/v0/b/')) {
      const body = Buffer.from(await response.clone().arrayBuffer());
      seen.push({ method: request.method, url, status: response.status, headers: response.headers, body });
    }
    return response;
  };
  globalThis.fetch = Object.assign(recording, { preconnect: () => {} }) as typeof fetch;
  return () => {
    globalThis.fetch = inner;
  };
}

beforeAll(async () => {
  capture = readCaptureS();
  scratch = mkdtempSync(join(tmpdir(), 'pyric-storage-capture-'));
  const recording = join(scratch, 'sign-ins.json');
  writeFileSync(recording, JSON.stringify(signIns(2)));
  server = await startReplayProcess([recording], undefined, { storageCapture: PROJECT });
  // Auth takes `fetch` once per process when it loads, so the seam goes in
  // first; the emulator connectors send every call to the server itself.
  stopRouting = routeFirebaseTo(server.origin);
  restoreFetch = recordStorageAnswers();
  firebase = (await import('firebase/app')) as FirebaseApp;
  auth = (await import('firebase/auth')) as FirebaseAuth;
  storage = (await import(pathToFileURL(storageNodeEntry()).href)) as FirebaseStorageSdk;
});

afterAll(async () => {
  for (const app of firebase?.getApps() ?? []) await firebase.deleteApp(app);
  restoreFetch?.();
  stopRouting?.();
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

interface Client {
  storage: FirebaseStorage;
}

/** A client of `bucket` for one run, signed in as `client-N` with a custom token, or never signed in. */
async function client(bucket: string, name: string, n: number | null): Promise<Client> {
  const app = firebase.initializeApp(CONFIG, `storage-s-${bucket}-${name}`);
  if (n !== null) {
    const appAuth = auth.getAuth(app);
    auth.connectAuthEmulator(appAuth, server.origin, { disableWarnings: true });
    await auth.signInWithCustomToken(appAuth, `client-${n}`);
  }
  const files = bucket === BUCKETS.default ? storage.getStorage(app) : storage.getStorage(app, `gs://${bucket}`);
  storage.connectStorageEmulator(files, '127.0.0.1', Number(new URL(server.origin).port));
  return { storage: files };
}

interface Result {
  ok: boolean;
  code?: string;
}

/** What the sequence saw besides each call's outcome. */
interface Observed {
  firstPage: { items: string[]; prefixes: string[]; token: boolean };
  secondPage: { items: string[]; prefixes: string[] };
  nested: { items: string[]; prefixes: string[] };
  pausedStates: string[];
  bytes: number;
  streamed: number;
}

/**
 * Pauses after the first chunk, in the turn after the SDK has made the next
 * chunk's request but before it is sent, and resumes once paused, as capture
 * S's script does. The resume asks the server what it received (`query`).
 */
async function pausedUpload(ref: StorageReference, states: string[]): Promise<void> {
  const task = storage.uploadBytesResumable(ref, RESUMABLE_BYTES);
  let pauseScheduled = false;
  let resumed = false;
  task.on('state_changed', (snapshot) => {
    states.push(snapshot.state);
    if (!pauseScheduled && snapshot.bytesTransferred > 0 && snapshot.state === 'running') {
      pauseScheduled = true;
      setTimeout(() => task.pause(), 0);
    }
    if (pauseScheduled && !resumed && snapshot.state === 'paused') {
      resumed = true;
      task.resume();
    }
  });
  await task;
}

/** The names a list result holds, relative to the run path. */
function names(refs: StorageReference[]): string[] {
  return refs.map((ref) => ref.fullPath.slice(RUN_PATH.length + 1));
}

/** Capture S's sequence on `bucket`, in its order: each outcome, and what the reads returned. */
async function runCaptureS(bucket: string): Promise<{ results: Record<string, Result>; observed: Observed }> {
  const one = await client(bucket, 'one', 1);
  const two = await client(bucket, 'two', 2);
  const signedOut = await client(bucket, 'signed-out', null);
  const results: Record<string, Result> = {};
  const observed: Partial<Observed> = { pausedStates: [] };
  const step = async (op: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      results[op] = { ok: true };
    } catch (error) {
      results[op] = { ok: false, code: String((error as { code?: unknown }).code ?? error) };
    }
  };
  const at = (c: Client, path: string) => storage.ref(c.storage, `${RUN_PATH}/${path}`);
  const denied = (c: Client, path: string) => storage.ref(c.storage, `${DENIED_PATH}/${path}`);
  const root = storage.ref(one.storage, RUN_PATH);

  await step('preflight', () => storage.listAll(root));
  await step('uploadBytes', () => storage.uploadBytes(at(one, 'a.bin'), SIX_BYTES));
  await step('uploadString-raw', () => storage.uploadString(at(one, 'raw.txt'), 'capture s', 'raw'));
  await step('uploadString-base64', () => storage.uploadString(at(one, 'b64.bin'), 'Y2FwdHVyZSBz', 'base64'));
  await step('uploadBytesResumable', async () => { await storage.uploadBytesResumable(at(one, 'big.bin'), RESUMABLE_BYTES); });
  await step('uploadBytesResumable-paused', () => pausedUpload(at(one, 'paused.bin'), observed.pausedStates!));
  await step('getMetadata', () => storage.getMetadata(at(one, 'a.bin')));
  await step('getDownloadURL', () => storage.getDownloadURL(at(one, 'a.bin')));
  await step('getBytes', async () => { observed.bytes = (await storage.getBytes(at(one, 'a.bin'))).byteLength; });
  await step('getStream', async () => { observed.streamed = (await new Response(storage.getStream(at(one, 'a.bin'))).arrayBuffer()).byteLength; });
  await step('updateMetadata', () => storage.updateMetadata(at(one, 'a.bin'), { cacheControl: 'no-store', customMetadata: { capture: 's' } }));
  await step('setup-nested', async () => {
    await storage.uploadString(at(one, 'nested/x/one.txt'), 'one', 'raw');
    await storage.uploadString(at(one, 'nested/two.txt'), 'two', 'raw');
  });
  await step('list', async () => {
    const first = await storage.list(root, { maxResults: 2 });
    observed.firstPage = { items: names(first.items), prefixes: names(first.prefixes), token: Boolean(first.nextPageToken) };
    const second = await storage.list(root, { maxResults: 2, pageToken: first.nextPageToken! });
    observed.secondPage = { items: names(second.items), prefixes: names(second.prefixes) };
  });
  await step('listAll', async () => {
    const nested = await storage.listAll(at(one, 'nested'));
    observed.nested = { items: names(nested.items), prefixes: names(nested.prefixes) };
  });
  await step('getMetadata-second-account', () => storage.getMetadata(at(two, 'a.bin')));
  await step('deleteObject', async () => {
    for (const path of OBJECTS) await storage.deleteObject(at(one, path));
  });
  await step('getMetadata-missing', () => storage.getMetadata(at(one, 'missing.bin')));
  await step('deleteObject-missing', () => storage.deleteObject(at(one, 'missing.bin')));
  await step('denied-upload', () => storage.uploadBytes(denied(two, 'forbidden.bin'), SIX_BYTES));
  await step('denied-getBytes', () => storage.getBytes(denied(two, 'forbidden.bin')));
  await step('denied-list', () => storage.list(denied(two, '')));
  await step('signed-out-upload', () => storage.uploadBytes(at(signedOut, 'signed-out.bin'), SIX_BYTES));
  // The capture's cleanup listed the run prefix twice, and read it back empty both times.
  await step('cleanup', async () => {
    for (let pass = 0; pass < 2; pass++) {
      const left = await storage.listAll(root);
      if (left.items.length + left.prefixes.length > 0) throw new Error('the run prefix is not empty');
    }
  });
  return { results, observed: observed as Observed };
}

/** A string from the replay with the values it picked written as capture S's placeholders. */
function placeheld(text: string): string {
  return text
    .replace(/upload_id=replay-upload-[0-9a-f-]{36}/g, 'upload_id=<upload-session>')
    .replaceAll(server.origin, 'https://firebasestorage.googleapis.com')
    .replaceAll(BUCKETS.default, '<bucket>')
    .replaceAll(BUCKETS.second, '<bucket>')
    .replace(/(pyric_oracle(?:_denied_storage)?)(\/|%2F)replay(?=\/|%2F)/g, '$1$2<run>');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Each key the replay fills, the shape its value must have, and the capture placeholder it stands for. */
const PICKED: Record<string, { shape: RegExp; placeholder: string }> = {
  generation: { shape: /^\d{16}$/, placeholder: '<generation>' },
  timeCreated: { shape: ISO_TIME, placeholder: '<time-created>' },
  updated: { shape: ISO_TIME, placeholder: '<time-updated>' },
  downloadTokens: { shape: UUID, placeholder: '<download-token>' },
  etag: { shape: new RegExp(`^${CAPTURE_S_ETAG}$`), placeholder: '<etag>' },
  nextPageToken: { shape: /^replay-page-\d+$/, placeholder: '<page-token>' },
};

/** A JSON answer with every value the replay picked written as capture S's placeholder, checked for its shape first. */
function placeheldJson(value: Json, key = ''): Json {
  const picked = PICKED[key];
  if (picked && typeof value === 'string') return picked.shape.test(value) ? picked.placeholder : `unexpected ${key}: ${value}`;
  if (typeof value === 'string') return placeheld(value);
  if (Array.isArray(value)) return value.map((item) => placeheldJson(item));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, placeheldJson(item, name)]));
}

/** A query value the SDK sent, with a page token or upload id the replay issued written as capture S's placeholder. */
function placeheldQuery(name: string, value: string): string {
  if (name === 'pageToken') return PICKED.nextPageToken!.shape.test(value) ? '<page-token>' : `unexpected pageToken: ${value}`;
  if (name === 'upload_id') return /^replay-upload-[0-9a-f-]{36}$/.test(value) ? '<upload-session>' : `unexpected upload_id: ${value}`;
  return placeheld(value);
}

/** An answer as capture S writes one: method, path, query, status, the headers the capture kept, and the body. */
function asCaptured(answer: SeenAnswer, keptHeaders: string[]): JsonObject {
  const headers = Object.fromEntries(keptHeaders.map((name) => [name, placeheld(answer.headers.get(name) ?? '<missing>')]));
  const contentType = answer.headers.get('content-type') ?? '';
  const body: Json = answer.body.length === 0 ? null
    : contentType.startsWith('application/json') ? { kind: 'json', json: placeheldJson(JSON.parse(answer.body.toString('utf8')) as Json) }
    : { kind: 'bytes', base64: answer.body.toString('base64') };
  const query = Object.fromEntries([...answer.url.searchParams].map(([name, value]) => [name, placeheldQuery(name, value)]));
  return { method: answer.method, path: placeheld(answer.url.pathname), query, status: answer.status, headers, body };
}

/** A capture S exchange in the same shape, with bytes compared by their content. */
function captured(exchange: CaptureSExchange): JsonObject {
  const body = exchange.response.body as CaptureBody | undefined;
  const asJson: Json = !body ? null : body.kind === 'json' ? { kind: 'json', json: body.json } : body.kind === 'bytes' ? { kind: 'bytes', base64: body.base64 ?? '' } : null;
  return { method: exchange.method, path: exchange.path, query: exchange.query, status: exchange.response.status, headers: exchange.response.headers, body: asJson };
}

function storageExchanges(): CaptureSExchange[] {
  return capture.exchanges.filter((exchange) => exchange.service === 'storage');
}

/** The outcome capture S recorded for each operation the sequence runs. */
function captureResults(results: Record<string, Result>): Record<string, Json> {
  const recorded = (capture as unknown as { results: Record<string, Result> }).results;
  return Object.fromEntries(Object.keys(results).map((op) => [op, recorded[op] as unknown as Json]));
}

describe.each([['the default bucket', BUCKETS.default], ['the second bucket', BUCKETS.second]])('capture S on %s', (_, bucket) => {
  test('the whole sequence gets capture S\'s answers, call for call, and nothing is unmatched', async () => {
    const before = seen.length;
    const { results, observed } = await runCaptureS(bucket);

    expect(results).toEqual(captureResults(results) as unknown as Record<string, Result>);
    expect(observed.firstPage).toEqual({ items: ['a.bin', 'b64.bin'], prefixes: [], token: true });
    expect(observed.secondPage).toEqual({ items: ['big.bin'], prefixes: ['nested'] });
    expect(observed.nested).toEqual({ items: ['nested/two.txt'], prefixes: ['nested/x'] });
    expect(observed.pausedStates).toContain('paused');
    expect(observed.bytes).toBe(6);
    expect(observed.streamed).toBe(6);

    const answers = seen.slice(before);
    expect(answers.every((answer) => answer.url.pathname.startsWith(`/v0/b/${encodeURIComponent(bucket)}/o`))).toBe(true);
    const expected = storageExchanges();
    expect(answers.map((answer, index) => asCaptured(answer, Object.keys(expected[index]?.response.headers ?? {})))).toEqual(expected.map(captured));
    expect(await unmatchedBy(server.origin)).toEqual([]);
  }, TIMEOUT_MS);
});

test('the paused upload resumed from the bytes the server received, and each call names its account', async () => {
  const storageCalls = (await receivedBy(server.origin)).filter((entry): entry is StorageReceived => entry.rpc === 'storage');
  const paused = storageCalls.filter((entry) => entry.message.bucket === BUCKETS.default && String((entry.message.query as JsonObject).name) === `${RUN_PATH}/paused.bin`);
  expect(paused.map((entry) => (entry.message.upload as JsonObject).command)).toEqual(['start', 'upload', 'query', 'upload', 'upload, finalize']);
  expect(paused.map((entry) => entry.message.bytes ?? null)).toEqual([null, 262144, null, 262144, 90112]);
  const accounts = new Set(storageCalls.map((entry) => entry.as));
  expect(accounts).toEqual(new Set(['user-1', 'user-2', null]));
  const signedOut = storageCalls.filter((entry) => entry.as === null);
  expect(signedOut.map((entry) => (entry.message.query as JsonObject).name)).toEqual([`${RUN_PATH}/signed-out.bin`, `${RUN_PATH}/signed-out.bin`]);
});

test('a chunk that starts past what its session received is refused, not answered from the capture', async () => {
  const token = await auth.getAuth(firebase.getApp(`storage-s-${BUCKETS.default}-one`)).currentUser!.getIdToken();
  const start = await fetch(`${server.origin}/v0/b/${BUCKETS.default}/o?name=${encodeURIComponent(`${RUN_PATH}/big.bin`)}`, {
    method: 'POST',
    headers: { authorization: `Firebase ${token}`, 'content-type': 'application/json; charset=utf-8', 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start', 'x-goog-upload-header-content-length': '614400', 'x-goog-upload-header-content-type': 'application/octet-stream' },
    body: JSON.stringify({ name: `${RUN_PATH}/big.bin`, contentType: 'application/octet-stream' }),
  });
  expect(start.status, await start.clone().text()).toBe(200);
  const uploadUrl = start.headers.get('x-goog-upload-url')!;
  const before = (await unmatchedBy(server.origin)).length;
  const skipped = await fetch(uploadUrl, { method: 'POST', headers: { authorization: `Firebase ${token}`, 'x-goog-upload-command': 'upload', 'x-goog-upload-offset': '262144' }, body: RESUMABLE_BYTES.slice(262144) });
  expect(skipped.status).toBe(400);
  expect(((await skipped.json()) as { error: { message: string } }).error.message).toContain('the chunk starts at 262144, but its session received 0 bytes');
  expect((await unmatchedBy(server.origin)).length).toBe(before + 1);
});

/** Starts a resumable upload of `RESUMABLE_BYTES` to `name` on the default bucket as the first account, and returns what sends its chunks and queries. */
async function resumableSession(name: string): Promise<(command: string, offset: number, bytes?: Uint8Array) => Promise<Response>> {
  const token = await auth.getAuth(firebase.getApp(`storage-s-${BUCKETS.default}-one`)).currentUser!.getIdToken();
  const start = await fetch(`${server.origin}/v0/b/${BUCKETS.default}/o?name=${encodeURIComponent(`${RUN_PATH}/${name}`)}`, {
    method: 'POST',
    headers: { authorization: `Firebase ${token}`, 'content-type': 'application/json; charset=utf-8', 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start', 'x-goog-upload-header-content-length': String(RESUMABLE_BYTES.length), 'x-goog-upload-header-content-type': 'application/octet-stream' },
    body: JSON.stringify({ name: `${RUN_PATH}/${name}`, contentType: 'application/octet-stream' }),
  });
  expect(start.status, await start.clone().text()).toBe(200);
  const uploadUrl = start.headers.get('x-goog-upload-url')!;
  return (command, offset, bytes) => {
    const headers: Record<string, string> = { authorization: `Firebase ${token}`, 'x-goog-upload-command': command };
    if (bytes) headers['x-goog-upload-offset'] = String(offset);
    return fetch(uploadUrl, { method: 'POST', headers, body: bytes });
  };
}

test('a resumed upload that sends the rest of its file in one final chunk gets production\'s final answer for the object', async () => {
  // A page's pause can land before the SDK makes the second chunk's request.
  // Nothing was cancelled, so the resume sends the rest at the doubled chunk
  // size: one `upload, finalize` of 352256 bytes at 262144, as production
  // accepted for big.bin (capture S's exchange 11). Production answers a
  // final chunk with the object it completes, paused.bin (exchange 16).
  const before = (await unmatchedBy(server.origin)).length;
  const send = await resumableSession('paused.bin');
  expect((await send('upload', 0, RESUMABLE_BYTES.slice(0, 262144))).status).toBe(200);
  const query = await send('query', 0);
  expect(query.headers.get('x-goog-upload-size-received')).toBe('262144');
  const rest = await send('upload, finalize', 262144, RESUMABLE_BYTES.slice(262144));
  const body = await rest.text();
  expect(rest.status, body).toBe(200);
  expect(rest.headers.get('x-goog-upload-status')).toBe('final');
  expect(JSON.parse(body)).toMatchObject({ name: `${RUN_PATH}/paused.bin`, bucket: BUCKETS.default, size: '614400', md5Hash: 'tZPO3O3DhIafgoYZFUhduw==' });
  expect((await unmatchedBy(server.origin)).length).toBe(before);
});

test('a final chunk is refused when its session\'s bytes are not the object production finalized', async () => {
  const before = (await unmatchedBy(server.origin)).length;
  const send = await resumableSession('paused.bin');
  expect((await send('upload', 0, RESUMABLE_BYTES.slice(0, 262144))).status).toBe(200);
  const other = RESUMABLE_BYTES.slice(262144).map((byte) => byte ^ 1);
  const rest = await send('upload, finalize', 262144, other);
  expect(rest.status).toBe(400);
  expect(((await rest.json()) as { error: { message: string } }).error.message).toContain('the bytes its session received hash to');
  expect((await unmatchedBy(server.origin)).length).toBe(before + 1);
});

test('metadata that is not JSON and a path with a bad % escape are refused with a 400 the SDK does not retry', async () => {
  const before = (await unmatchedBy(server.origin)).length;
  const badJson = await fetch(`${server.origin}/v0/b/${BUCKETS.default}/o/${encodeURIComponent(`${RUN_PATH}/a.bin`)}`, { method: 'PATCH', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{not json' });
  expect(badJson.status).toBe(400);
  expect(((await badJson.json()) as { error: { message: string } }).error.message).toBe(`pyric_replay_no_recording: the replay cannot answer PATCH gs://${BUCKETS.default}/${RUN_PATH}/a.bin: the metadata it sent is not JSON`);
  const badEscape = await fetch(`${server.origin}/v0/b/${BUCKETS.default}/o/bad%E0%A4%A`);
  expect(badEscape.status).toBe(400);
  expect(((await badEscape.json()) as { error: { message: string } }).error.message).toBe(`pyric_replay_no_recording: the replay cannot answer GET gs://${BUCKETS.default}/bad%E0%A4%A: its path has a bad % escape`);
  expect((await unmatchedBy(server.origin)).length).toBe(before + 2);
});
