/**
 * The live-storage row over the real `firebase/storage` (its Node build, in
 * Bun, which has no `XMLHttpRequest` for the browser build), driven through
 * capture S against the in-process replay server, so every call crosses real
 * HTTP and gets the answers production sent. The app's code is plain SDK
 * code through the wrapped module, on the default bucket and on the second
 * one, which the replay serves from the same recording with the bucket
 * renamed. Each record must name the project, the account its app's Auth
 * holds, the bucket and the path its reference names, and production's
 * `storage/*` code on a failure.
 *
 * Capture S has no denied resumable upload. A task the app only listens to
 * with `task.on(...)` is made with `uploadBytesResumable` and capture S's six
 * bytes, which the SDK sends as the same multipart upload capture S recorded
 * for the denied `uploadBytes`, so production's 403 answers it. A task the
 * app cancels at once is canceled before it sends anything.
 *
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/storage-row.test.ts'`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as realApp from 'firebase/app';
import * as realAuth from 'firebase/auth';
import type { FirebaseStorage, StorageReference, UploadTask } from 'firebase/storage';
import { observedCallOf } from '../src/page-observer.js';
import { sessionDataOf } from '../src/session-data.js';
import { wrapLiveModule, type LiveCallRecord, type LiveModuleSite, type LiveObserver } from '../src/index.js';
import { storageContext, storageResult, UNREAD_BUCKET } from '../src/storage.js';
import { UNREAD_BUCKET as HOST_UNREAD_BUCKET } from '@pyric/cli/vite/internal/supplied-rows';

/** A replay recording, as `test/apps/replay/format.ts` defines it. */
interface Recording {
  readonly format: string;
  readonly project: string;
  readonly source: string;
  readonly exchanges: readonly object[];
}

/** The in-process replay server `test/apps/replay/server.ts` starts. */
interface ReplayServer {
  readonly origin: string;
  readonly unmatched: unknown[];
  close(): Promise<void>;
}

/** The replay helpers this test uses from `test/apps/replay/`. */
interface Replay {
  readonly FORMAT: string;
  readonly CAPTURE_S_RUN: string;
  captureSBuckets(project: string): { default: string; second: string };
  loadCaptureS(project: string): Recording;
  routeFirebaseTo(origin: string): () => void;
  startReplayServer(recordings: Recording[]): Promise<ReplayServer>;
}

/**
 * Loads the replay helpers at run time. They import their siblings with a
 * `.ts` extension, which this package's typecheck does not take, so they stay
 * out of it and this test declares the part it uses.
 */
async function loadReplay(): Promise<Replay> {
  const load = (name: string) => import(new URL(`../../../test/apps/replay/${name}.ts`, import.meta.url).href);
  const [format, capture, seam, server] = await Promise.all([load('format'), load('storage-capture'), load('seam'), load('server')]);
  return { ...format, ...capture, ...seam, ...server } as Replay;
}

const replay = await loadReplay();
const PROJECT = 'demo-live-storage';
const BUCKETS = replay.captureSBuckets(PROJECT);
const CONFIG = { projectId: PROJECT, apiKey: 'test-api-key', appId: '1:1:web:live-storage', storageBucket: BUCKETS.default };
const RUN_PATH = `pyric_oracle/${replay.CAPTURE_S_RUN}`;
const DENIED_PATH = `pyric_oracle_denied_storage/${replay.CAPTURE_S_RUN}`;
/** The bytes capture S uploaded, as its script makes them. */
const SIX_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6]);
const RESUMABLE_BYTES = Uint8Array.from({ length: 600 * 1024 }, (_, i) => i % 251);
const OBJECTS = ['a.bin', 'raw.txt', 'b64.bin', 'big.bin', 'paused.bin', 'nested/x/one.txt', 'nested/two.txt'];
const TIMEOUT_MS = 60_000;

type FirebaseStorageSdk = typeof import('firebase/storage');

/** `@firebase/storage`'s Node ESM build, the one a server runs, found next to the build `firebase/storage` resolves to. */
function storageNodeEntry(): string {
  const firebaseStorage = createRequire(import.meta.url).resolve('firebase/storage');
  const entry = createRequire(firebaseStorage).resolve('@firebase/storage');
  return join(dirname(entry), 'node-esm', 'index.node.esm.js');
}

/** Custom-token sign-ins: `client-N` gets an anonymous ID token for `user-N`, the uid capture S's `<uid-N>` becomes. */
function signIns(count: number): Recording {
  const exchanges: object[] = [];
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
  return { format: replay.FORMAT, project: PROJECT, source: 'hand-written from the Auth REST v1 wire format', exchanges };
}

const records: LiveCallRecord[] = [];
const observer: LiveObserver = (record) => {
  records.push(record);
};
const site: LiveModuleSite = { observer, sdkVersion: realApp.SDK_VERSION, client: 'node' };
const auth = wrapLiveModule('live-auth', 'firebase/auth', realAuth, site);
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

let server: ReplayServer;
let stopRouting: () => void;
let port: number;
let real: FirebaseStorageSdk;
let live: FirebaseStorageSdk;

beforeAll(async () => {
  server = await replay.startReplayServer([replay.loadCaptureS(PROJECT), signIns(2)]);
  port = Number(new URL(server.origin).port);
  stopRouting = replay.routeFirebaseTo(server.origin);
  real = (await import(pathToFileURL(storageNodeEntry()).href)) as FirebaseStorageSdk;
  live = wrapLiveModule('live-storage', 'firebase/storage', real, site);
  process.on('unhandledRejection', onUnhandled);
});

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  for (const app of realApp.getApps()) await realApp.deleteApp(app);
  stopRouting();
  await server.close();
});

/** A client of `bucket`, signed in as `client-N` with a custom token, or never signed in. */
async function client(bucket: string, name: string, n: number | null): Promise<FirebaseStorage> {
  const app = realApp.initializeApp(CONFIG, `live-storage-${bucket}-${name}`);
  if (n !== null) {
    const appAuth = auth.getAuth(app);
    realAuth.connectAuthEmulator(appAuth, server.origin, { disableWarnings: true });
    await auth.signInWithCustomToken(appAuth, `client-${n}`);
  }
  const files = bucket === BUCKETS.default ? live.getStorage(app) : live.getStorage(app, `gs://${bucket}`);
  live.connectStorageEmulator(files, '127.0.0.1', port);
  return files;
}

/**
 * Pauses after the first chunk and resumes once paused, as capture S's
 * script does, through the wrapped module. Returns the task and the states
 * it went through.
 */
async function pausedUpload(ref: StorageReference): Promise<{ task: UploadTask; states: string[] }> {
  const task = live.uploadBytesResumable(ref, RESUMABLE_BYTES);
  const states: string[] = [];
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
  return { task, states };
}

interface Drive {
  results: Record<string, string>;
  pausedIsTask: boolean;
  pausedStates: string[];
  pausedState: string;
  streamed: number;
  getBlobThrew: boolean;
}

/** Capture S's sequence on `bucket`, in its order, every call through the wrapped module. */
async function drive(bucket: string): Promise<Drive> {
  const one = await client(bucket, 'one', 1);
  const two = await client(bucket, 'two', 2);
  const signedOut = await client(bucket, 'signed-out', null);
  const results: Record<string, string> = {};
  const step = async (op: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      results[op] = 'ok';
    } catch (error) {
      results[op] = String((error as { code?: unknown }).code ?? error);
    }
  };
  const at = (files: FirebaseStorage, path: string) => live.ref(files, `${RUN_PATH}/${path}`);
  const denied = (files: FirebaseStorage, path: string) => live.ref(files, `${DENIED_PATH}/${path}`);
  const root = live.ref(one, RUN_PATH);
  let paused: { task: UploadTask; states: string[] } | undefined;
  let streamed = -1;
  let getBlobThrew = false;

  await step('preflight', () => live.listAll(root));
  await step('uploadBytes', () => live.uploadBytes(at(one, 'a.bin'), SIX_BYTES));
  await step('uploadString-raw', () => live.uploadString(at(one, 'raw.txt'), 'capture s', 'raw'));
  await step('uploadString-base64', () => live.uploadString(at(one, 'b64.bin'), 'Y2FwdHVyZSBz', 'base64'));
  await step('uploadBytesResumable', async () => { await live.uploadBytesResumable(at(one, 'big.bin'), RESUMABLE_BYTES); });
  await step('uploadBytesResumable-paused', async () => { paused = await pausedUpload(at(one, 'paused.bin')); });
  await step('getMetadata', () => live.getMetadata(at(one, 'a.bin')));
  await step('getDownloadURL', () => live.getDownloadURL(at(one, 'a.bin')));
  await step('getBytes', () => live.getBytes(at(one, 'a.bin')));
  try {
    live.getBlob(at(one, 'a.bin'));
  } catch {
    getBlobThrew = true;
  }
  await step('getStream', async () => { streamed = (await new Response(live.getStream(at(one, 'a.bin'))).arrayBuffer()).byteLength; });
  await step('updateMetadata', () => live.updateMetadata(at(one, 'a.bin'), { cacheControl: 'no-store', customMetadata: { capture: 's' } }));
  await step('setup-nested', async () => {
    await live.uploadString(at(one, 'nested/x/one.txt'), 'one', 'raw');
    await live.uploadString(at(one, 'nested/two.txt'), 'two', 'raw');
  });
  await step('list', async () => {
    const first = await live.list(root, { maxResults: 2 });
    await live.list(root, { maxResults: 2, pageToken: first.nextPageToken! });
  });
  await step('listAll', () => live.listAll(at(one, 'nested')));
  await step('getMetadata-second-account', () => live.getMetadata(at(two, 'a.bin')));
  await step('deleteObject', async () => {
    for (const path of OBJECTS) await live.deleteObject(at(one, path));
  });
  await step('getMetadata-missing', () => live.getMetadata(at(one, 'missing.bin')));
  await step('deleteObject-missing', () => live.deleteObject(at(one, 'missing.bin')));
  await step('denied-upload', () => live.uploadBytes(denied(two, 'forbidden.bin'), SIX_BYTES));
  await step('denied-getBytes', () => live.getBytes(denied(two, 'forbidden.bin')));
  await step('denied-list', () => live.list(denied(two, '')));
  await step('signed-out-upload', () => live.uploadBytes(at(signedOut, 'signed-out.bin'), SIX_BYTES));
  await step('cleanup', async () => {
    for (let pass = 0; pass < 2; pass++) await live.listAll(root);
  });
  return {
    results,
    // The SDK exports its task class as `_UploadTask`; its types leave it out.
    pausedIsTask: paused?.task instanceof (Reflect.get(real, '_UploadTask') as abstract new (...args: never[]) => object),
    pausedStates: paused?.states ?? [],
    pausedState: paused?.task.snapshot.state ?? 'none',
    streamed,
    getBlobThrew,
  };
}

/** A record without its module and production's message (asserted on its own), and its account as the uid. */
function shape(record: LiveCallRecord): Record<string, unknown> {
  const { module: _module, account, message: _message, writeData: _writeData, document: _document, ...rest } = record;
  return { ...rest, account: account?.uid ?? null };
}

describe.each([['the default bucket', BUCKETS.default], ['the second bucket', BUCKETS.second]])('the live-storage row over capture S on %s', (_, bucket) => {
  let run: Drive;
  let own: LiveCallRecord[];

  beforeAll(async () => {
    const before = records.length;
    run = await drive(bucket);
    own = records.slice(before).filter((record) => record.module === 'firebase/storage');
  }, TIMEOUT_MS);

  test("every call gets capture S's answer, and the replay received only calls capture S recorded", () => {
    expect(run.results).toEqual({
      preflight: 'ok',
      uploadBytes: 'ok',
      'uploadString-raw': 'ok',
      'uploadString-base64': 'ok',
      uploadBytesResumable: 'ok',
      'uploadBytesResumable-paused': 'ok',
      getMetadata: 'ok',
      getDownloadURL: 'ok',
      getBytes: 'ok',
      getStream: 'ok',
      updateMetadata: 'ok',
      'setup-nested': 'ok',
      list: 'ok',
      listAll: 'ok',
      'getMetadata-second-account': 'ok',
      deleteObject: 'ok',
      'getMetadata-missing': 'storage/object-not-found',
      'deleteObject-missing': 'storage/object-not-found',
      'denied-upload': 'storage/unauthorized',
      'denied-getBytes': 'storage/unauthorized',
      'denied-list': 'storage/unauthorized',
      'signed-out-upload': 'storage/unauthorized',
      cleanup: 'ok',
    });
    expect(server.unmatched).toEqual([]);
  });

  test('records each call once with its project, account, bucket and path, and production code on a failure', () => {
    const where = (path: string, account: string | null = 'user-1') => ({ projectId: PROJECT, bucket, path, account });
    const ok = (name: string, path: string, account?: string | null) => ({ name, outcome: 'resolved', ...where(path, account) });
    const failed = (name: string, code: string, path: string, account?: string | null) => ({ name, outcome: 'rejected', code, ...where(path, account) });
    expect(own.map(shape)).toEqual([
      ok('listAll', RUN_PATH),
      ok('uploadBytes', `${RUN_PATH}/a.bin`),
      ok('uploadString', `${RUN_PATH}/raw.txt`),
      ok('uploadString', `${RUN_PATH}/b64.bin`),
      ok('uploadBytesResumable', `${RUN_PATH}/big.bin`),
      ok('uploadBytesResumable', `${RUN_PATH}/paused.bin`),
      ok('getMetadata', `${RUN_PATH}/a.bin`),
      ok('getDownloadURL', `${RUN_PATH}/a.bin`),
      ok('getBytes', `${RUN_PATH}/a.bin`),
      ok('getStream', `${RUN_PATH}/a.bin`),
      ok('updateMetadata', `${RUN_PATH}/a.bin`),
      ok('uploadString', `${RUN_PATH}/nested/x/one.txt`),
      ok('uploadString', `${RUN_PATH}/nested/two.txt`),
      ok('list', RUN_PATH),
      ok('list', RUN_PATH),
      ok('listAll', `${RUN_PATH}/nested`),
      ok('getMetadata', `${RUN_PATH}/a.bin`, 'user-2'),
      ...OBJECTS.map((path) => ok('deleteObject', `${RUN_PATH}/${path}`)),
      failed('getMetadata', 'storage/object-not-found', `${RUN_PATH}/missing.bin`),
      failed('deleteObject', 'storage/object-not-found', `${RUN_PATH}/missing.bin`),
      failed('uploadBytes', 'storage/unauthorized', `${DENIED_PATH}/forbidden.bin`, 'user-2'),
      failed('getBytes', 'storage/unauthorized', `${DENIED_PATH}/forbidden.bin`, 'user-2'),
      failed('list', 'storage/unauthorized', DENIED_PATH, 'user-2'),
      failed('uploadBytes', 'storage/unauthorized', `${RUN_PATH}/signed-out.bin`, null),
      ok('listAll', RUN_PATH),
      ok('listAll', RUN_PATH),
    ]);
  });

  test("the resumable upload is the SDK's own UploadTask, paused and resumed, with one record", () => {
    expect(run.pausedIsTask).toBe(true);
    expect(run.pausedStates).toContain('paused');
    expect(run.pausedState).toBe('success');
  });

  test('getStream hands the app the bytes, and getBlob, which the Node build refuses before any request, makes no record', () => {
    expect(run.streamed).toBe(6);
    expect(run.getBlobThrew).toBe(true);
    expect(own.some((record) => record.name === 'getBlob')).toBe(false);
  });
});

describe('upload tasks and streams the app does not await', () => {
  let one: FirebaseStorage;
  let two: FirebaseStorage;

  beforeAll(async () => {
    one = await client(BUCKETS.default, 'tasks-one', 1);
    two = await client(BUCKETS.default, 'tasks-two', 2);
  });

  test('a denied task the app only listens to records the denial and raises no unhandled rejection', async () => {
    const before = records.length;
    const unhandledBefore = unhandled.length;
    const task = live.uploadBytesResumable(live.ref(two, `${DENIED_PATH}/forbidden.bin`), SIX_BYTES);
    const code = await new Promise<unknown>((resolve) => {
      task.on('state_changed', undefined, (error) => resolve(error.code));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(code).toBe('storage/unauthorized');
    expect(unhandled.length).toBe(unhandledBefore);
    expect(records.slice(before).map(shape)).toEqual([
      { name: 'uploadBytesResumable', outcome: 'rejected', code: 'storage/unauthorized', projectId: PROJECT, bucket: BUCKETS.default, path: `${DENIED_PATH}/forbidden.bin`, account: 'user-2' },
    ]);
    // Production's message, as the SDK's error held it.
    expect(records[before]!.message).toBe(`Firebase Storage: User does not have permission to access '${DENIED_PATH}/forbidden.bin'. (storage/unauthorized)`);
    expect(server.unmatched).toEqual([]);
  });

  test('a task canceled at once records storage/canceled and sends nothing', async () => {
    const before = records.length;
    const task = live.uploadBytesResumable(live.ref(one, `${RUN_PATH}/canceled.bin`), SIX_BYTES);
    expect(task.cancel()).toBe(true);
    const code = await task.then(() => 'ok', (error: { code?: string }) => error.code);
    expect(code).toBe('storage/canceled');
    expect(records.slice(before).map(shape)).toEqual([
      { name: 'uploadBytesResumable', outcome: 'rejected', code: 'storage/canceled', projectId: PROJECT, bucket: BUCKETS.default, path: `${RUN_PATH}/canceled.bin`, account: 'user-1' },
    ]);
    expect(sessionDataOf(records[before]!)).toBeUndefined();
    expect(server.unmatched).toEqual([]);
  });

  test("a denied stream errors with production's code, recorded once", async () => {
    const before = records.length;
    const stream = live.getStream(live.ref(two, `${DENIED_PATH}/forbidden.bin`)) as ReadableStream<Uint8Array>;
    const code = await new Response(stream).arrayBuffer().then(() => 'ok', (error: { code?: string }) => error.code);
    expect(code).toBe('storage/unauthorized');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(records.slice(before).map(shape)).toEqual([
      { name: 'getStream', outcome: 'rejected', code: 'storage/unauthorized', projectId: PROJECT, bucket: BUCKETS.default, path: `${DENIED_PATH}/forbidden.bin`, account: 'user-2' },
    ]);
  });

  test('a root reference names its bucket and no path, and a call the SDK refuses before any request makes no record', () => {
    const before = records.length;
    const root = live.ref(one);
    expect(storageContext('list', [root])).toEqual({ subject: one.app, projectId: PROJECT, bucket: BUCKETS.default });
    expect(() => live.uploadBytes(root, SIX_BYTES)).toThrow();
    expect(records.length).toBe(before);
  });
});

describe('the observed call a record becomes', () => {
  test("a denial carries production's code, the bucket and the path; a root call carries no path", () => {
    const denied: LiveCallRecord = { module: 'firebase/storage', name: 'uploadBytes', outcome: 'rejected', code: 'storage/unauthorized', projectId: PROJECT, account: { uid: 'user-2' }, bucket: BUCKETS.second, path: `${DENIED_PATH}/forbidden.bin` };
    expect(observedCallOf(denied, 7)).toEqual({
      service: 'storage',
      method: 'uploadBytes',
      at: 7,
      outcome: { status: 'error', code: 'storage/unauthorized' },
      projectId: PROJECT,
      account: { uid: 'user-2' },
      bucket: BUCKETS.second,
      path: `${DENIED_PATH}/forbidden.bin`,
    });
    const atRoot: LiveCallRecord = { module: 'firebase/storage', name: 'list', outcome: 'resolved', bucket: BUCKETS.default };
    expect(observedCallOf(atRoot, 7)).toEqual({ service: 'storage', method: 'list', at: 7, outcome: { status: 'ok' }, bucket: BUCKETS.default });
  });

  test('a Storage record without a bucket names the unread bucket, which a host takes', () => {
    const unread = storageContext('getMetadata', [{ bucket: 'gs://not-bare', fullPath: 'a' }]);
    expect(unread).toEqual({ bucket: UNREAD_BUCKET, path: 'a' });
    const record: LiveCallRecord = { module: 'firebase/storage', name: 'getMetadata', outcome: 'resolved' };
    expect(observedCallOf(record, 7)?.bucket).toBe(UNREAD_BUCKET);
  });

  test('the unread bucket is the one the host reads as no bucket named', () => {
    expect(UNREAD_BUCKET).toBe(HOST_UNREAD_BUCKET);
  });
});

describe('the metadata a Storage call sent or read', () => {
  test('an upload or metadata update scrubs secret customMetadata on both Traffic writeData/document and sessionData, never sending bytes', () => {
    const fakeRef = { bucket: 'demo.appspot.com', fullPath: 'uploads/a.txt', storage: { app: { options: { projectId: 'demo' } } } };
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const uploadCtx = storageContext('uploadBytes', [
      fakeRef,
      bytes,
      {
        contentType: 'text/plain',
        customMetadata: { owner: 'alice', apiKey: 'must-be-redacted', firebaseStorageDownloadTokens: 'tok-1' },
      },
    ]);
    expect(uploadCtx.writeData).toEqual({
      contentType: 'text/plain',
      customMetadata: { owner: 'alice', apiKey: '[REDACTED]', firebaseStorageDownloadTokens: '[REDACTED]' },
      size: 4,
    });
    const stringCtx = storageContext('uploadString', [fakeRef, 'data:image/png;base64,AQIDBA==', 'data_url']);
    expect(stringCtx.writeData).toEqual({ contentType: 'image/png', size: 4 });
    const updateCtx = storageContext('updateMetadata', [fakeRef, { cacheControl: 'max-age=60', contentType: null }]);
    expect(updateCtx.writeData).toEqual({ cacheControl: 'max-age=60', contentType: null });
    const metaResult = storageResult(
      { name: 'getMetadata' } as Parameters<typeof storageResult>[0],
      {
        size: 42,
        contentType: 'image/png',
        customMetadata: { role: 'avatar', apiKey: 'must-be-redacted' },
        fullPath: 'uploads/a.png',
        bucket: 'demo.appspot.com',
        ignoredBlob: new Uint8Array([9]),
      },
    );
    const expectedDoc = {
      size: 42,
      contentType: 'image/png',
      customMetadata: { role: 'avatar', apiKey: '[REDACTED]' },
      fullPath: 'uploads/a.png',
      bucket: 'demo.appspot.com',
    };
    expect(metaResult).toEqual({
      document: expectedDoc,
      sessionData: {
        storage: [
          {
            kind: 'upsert',
            bucket: 'demo.appspot.com',
            fullPath: 'uploads/a.png',
            replaceMetadata: true,
            metadata: {
              size: 42,
              contentType: 'image/png',
              customMetadata: { role: 'avatar', apiKey: '[REDACTED]' },
            },
          },
        ],
      },
    });
    expect(observedCallOf({ module: 'firebase/storage', name: 'getMetadata', outcome: 'resolved', bucket: 'demo.appspot.com', path: 'uploads/a.png', document: expectedDoc }, 1)?.document).toEqual(expectedDoc);
  });
});
