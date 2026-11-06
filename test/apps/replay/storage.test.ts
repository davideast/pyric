/**
 * The Node build of the real `firebase/storage` SDK uploads, reads metadata
 * and gets a denial from the replay server, answered from a minimal fixture
 * taken from capture S. The app code below is plain SDK code: it points Auth
 * and Storage at the replay server with `connectAuthEmulator` and
 * `connectStorageEmulator`, and passes no `mockUserToken`, so the ID token
 * Auth minted is the one the `Authorization: Firebase` header carries.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/storage.test.ts'`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FirebaseStorage } from 'firebase/storage';
import { assertShapesOnly, readRecording, type Recording, type StorageExchange } from './format.ts';
import { routeFirebaseTo } from './seam.ts';
import { startReplayServer, type ReplayServer } from './server.ts';
import { NO_RECORDING } from './storage.ts';

const MINIMAL = join(import.meta.dir, 'fixtures', 'storage-minimal.json');
const PROJECT = 'demo-replay-storage';
const BUCKET = `${PROJECT}.firebasestorage.app`;
const CONFIG = { projectId: PROJECT, apiKey: 'test-api-key', appId: '1:1:web:replay-storage', storageBucket: BUCKET };
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type FirebaseApp = typeof import('firebase/app');
type FirebaseAuth = typeof import('firebase/auth');
type FirebaseStorageSdk = typeof import('firebase/storage');

/** `@firebase/storage`'s Node ESM build, the one a server runs, found next to the build `firebase/storage` resolves to. */
function storageNodeEntry(): string {
  const firebaseStorage = createRequire(import.meta.url).resolve('firebase/storage');
  const entry = createRequire(firebaseStorage).resolve('@firebase/storage');
  return join(dirname(entry), 'node-esm', 'index.node.esm.js');
}

let server: ReplayServer;
let stopRouting: () => void;
let port: number;
let firebase: FirebaseApp;
let auth: FirebaseAuth;
let storage: FirebaseStorageSdk;
let apps = 0;

beforeAll(async () => {
  server = await startReplayServer([readRecording(MINIMAL)]);
  port = Number(new URL(server.origin).port);
  // Auth takes `fetch` once per process when it loads, and other replay test
  // files share this one, so the seam goes in first. The emulator connectors
  // route around it; the seam test below goes through it.
  stopRouting = routeFirebaseTo(server.origin);
  firebase = (await import('firebase/app')) as FirebaseApp;
  auth = (await import('firebase/auth')) as FirebaseAuth;
  storage = (await import(pathToFileURL(storageNodeEntry()).href)) as FirebaseStorageSdk;
});

afterAll(async () => {
  for (const app of firebase.getApps()) await firebase.deleteApp(app);
  stopRouting();
  await server.close();
});

beforeEach(() => {
  server.unmatched.length = 0;
});

/** A fresh app signed in anonymously, its Storage pointed at the replay server unless `viaSeam`. */
async function appStorage(viaSeam = false): Promise<FirebaseStorage> {
  apps += 1;
  const app = firebase.initializeApp(CONFIG, `storage-replay-${apps}`);
  const appAuth = auth.getAuth(app);
  auth.connectAuthEmulator(appAuth, server.origin, { disableWarnings: true });
  await auth.signInAnonymously(appAuth);
  const instance = storage.getStorage(app);
  if (!viaSeam) storage.connectStorageEmulator(instance, '127.0.0.1', port);
  return instance;
}

describe('Storage REST answered from capture S', () => {
  test('uploadBytes is answered with production\'s resource, its token, generation and time filled', async () => {
    const result = await storage.uploadBytes(storage.ref(await appStorage(), 'pyric_oracle/a.bin'), BYTES);
    expect(result.metadata).toMatchObject({ bucket: BUCKET, fullPath: 'pyric_oracle/a.bin', name: 'a.bin', size: 6, contentType: 'application/octet-stream', md5Hash: 'asHla8ePAxBZvnvoVFIsTA==' });
    expect(result.metadata.generation).toMatch(/^\d{16}$/);
    expect(new Date(result.metadata.timeCreated).toISOString()).toBe(result.metadata.timeCreated);
    expect(server.storage.at(-1)).toEqual({
      rpc: 'storage',
      as: 'user-1',
      message: { method: 'POST', bucket: BUCKET, query: { name: 'pyric_oracle/a.bin' }, upload: { protocol: 'multipart' }, bytes: 6 },
    });
    expect(server.unmatched).toEqual([]);
  });

  test('getMetadata fills the downloadTokens placeholder with the token the upload got', async () => {
    const files = await appStorage();
    const uploaded = await storage.uploadBytes(storage.ref(files, 'pyric_oracle/a.bin'), BYTES);
    const metadata = await storage.getMetadata(storage.ref(files, 'pyric_oracle/a.bin'));
    expect(metadata).toMatchObject({ fullPath: 'pyric_oracle/a.bin', size: 6, generation: uploaded.metadata.generation, timeCreated: uploaded.metadata.timeCreated });
    expect(server.storage.at(-1)?.message).toEqual({ method: 'GET', bucket: BUCKET, object: 'pyric_oracle/a.bin', query: {} });
    // The SDK keeps downloadTokens off its metadata and reads it for getDownloadURL, the same GET.
    const url = new URL(await storage.getDownloadURL(storage.ref(files, 'pyric_oracle/a.bin')));
    expect(`${url.origin}${url.pathname}`).toBe(`${server.origin}/v0/b/${BUCKET}/o/pyric_oracle%2Fa.bin`);
    expect(url.searchParams.get('alt')).toBe('media');
    expect(url.searchParams.get('token')).toMatch(UUID);
    const again = new URL(await storage.getDownloadURL(storage.ref(files, 'pyric_oracle/a.bin')));
    expect(again.searchParams.get('token')).toBe(url.searchParams.get('token'));
    expect(server.unmatched).toEqual([]);
  });

  test('a denied upload gets production\'s 403, which the SDK reads as storage/unauthorized', async () => {
    const upload = storage.uploadBytes(storage.ref(await appStorage(), 'pyric_oracle_denied_storage/forbidden.bin'), BYTES);
    await expect(upload).rejects.toMatchObject({ code: 'storage/unauthorized', status: 403 });
    expect(server.unmatched).toEqual([]);
  });

  test('an unrecorded path is rejected with pyric_replay_no_recording, at once, and listed in unmatched', async () => {
    const started = Date.now();
    const upload = storage.uploadBytes(storage.ref(await appStorage(), 'pyric_oracle/unrecorded.bin'), BYTES);
    await expect(upload).rejects.toMatchObject({ code: 'storage/unknown', status: 400 });
    // A 5xx would be retried for up to two minutes; the 400 is not retried.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(server.unmatched).toEqual([{
      rpc: 'http',
      as: 'user-1',
      request: { service: 'storage', method: 'POST', bucket: BUCKET, query: { name: 'pyric_oracle/unrecorded.bin' }, upload: { protocol: 'multipart' }, bytes: 6 },
    }]);
  });

  test('the refusal names the call: the Node SDK keeps an HTTP error\'s body off its message, so read it on the wire', async () => {
    const response = await fetch(`${server.origin}/v0/b/${BUCKET}/o/pyric_oracle%2Funrecorded.bin`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 400, message: `${NO_RECORDING}: no recorded Storage call answers GET gs://${BUCKET}/pyric_oracle/unrecorded.bin` } });
    expect(server.unmatched).toEqual([{ rpc: 'http', as: null, request: { service: 'storage', method: 'GET', bucket: BUCKET, query: {}, object: 'pyric_oracle/unrecorded.bin' } }]);
  });

  test('different bytes under a recorded name are not answered by its recording', async () => {
    const upload = storage.uploadBytes(storage.ref(await appStorage(), 'pyric_oracle/a.bin'), new Uint8Array([9, 9]));
    await expect(upload).rejects.toMatchObject({ status: 400 });
    expect(server.unmatched).toHaveLength(1);
  });

  test('without the emulator connector, the seam routes firebasestorage.googleapis.com to the replay', async () => {
    const metadata = await storage.getMetadata(storage.ref(await appStorage(true), 'pyric_oracle/a.bin'));
    expect(metadata.fullPath).toBe('pyric_oracle/a.bin');
    expect(server.unmatched).toEqual([]);
  });
});

describe('the replay serves a page\'s Storage XHR', () => {
  test('a CORS preflight allows PATCH and DELETE with the headers the SDK sends', async () => {
    for (const method of ['PATCH', 'DELETE']) {
      const response = await fetch(`${server.origin}/v0/b/${BUCKET}/o/pyric_oracle%2Fa.bin`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:5173', 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type,x-firebase-gmpid,x-firebase-storage-version' },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-methods')?.split(', ')).toContain(method);
      expect(response.headers.get('access-control-allow-headers')).toBe('authorization,content-type,x-firebase-gmpid,x-firebase-storage-version');
    }
  });

  test('a cross-origin answer exposes the upload headers a resumable upload reads', async () => {
    const response = await fetch(`${server.origin}/v0/b/${BUCKET}/o/pyric_oracle%2Fa.bin`, { headers: { origin: 'http://localhost:5173' } });
    await response.text();
    const exposed = response.headers.get('access-control-expose-headers')?.split(', ');
    expect(exposed).toEqual(['x-http-session-id', 'x-goog-upload-status', 'x-goog-upload-url', 'x-goog-upload-size-received', 'x-goog-upload-chunk-granularity']);
  });
});

describe('the storage exchange format', () => {
  const recording = (): Recording => readRecording(MINIMAL);
  const upload = (value: Recording): StorageExchange => value.exchanges.find((exchange) => exchange.id === 'upload-bytes') as StorageExchange;

  test('a bucket outside the project is refused', () => {
    const value = recording();
    upload(value).request.bucket = 'someone-else.firebasestorage.app';
    expect(() => assertShapesOnly(value)).toThrow('names someone-else.firebasestorage.app, outside project demo-replay-storage');
  });

  test('a download token, generation or creation time production picked must be a placeholder', () => {
    for (const [key, placeholder] of [['downloadTokens', 'downloadToken'], ['generation', 'generation'], ['timeCreated', 'timeCreated']] as const) {
      const value = recording();
      (upload(value).response.body as Record<string, unknown>)[key] = 'a-literal';
      expect(() => assertShapesOnly(value)).toThrow(`${key} must be the placeholder {"$":"${placeholder}"}`);
    }
  });

  test('an upload URL and an upload id must be the uploadSession placeholder', () => {
    const value = recording();
    upload(value).response.headers = { 'x-goog-upload-url': 'https://firebasestorage.googleapis.com/v0/b/x/o?upload_id=abc' };
    expect(() => assertShapesOnly(value)).toThrow('x-goog-upload-url must be the placeholder {"$":"uploadSession"}');
    const query = recording();
    upload(query).request.query = { name: 'pyric_oracle/a.bin', upload_id: 'abc' };
    expect(() => assertShapesOnly(query)).toThrow('upload_id must be the placeholder {"$":"uploadSession"}');
  });
});

test('an uploadSession placeholder answers with an upload URL on the replay, and matches only the ids it issued', async () => {
  const session: Recording = {
    format: 'pyric-replay/1',
    project: PROJECT,
    source: 'hand-written: a resumable start and its first chunk, shaped as capture S recorded them',
    exchanges: [
      {
        kind: 'storage',
        id: 'resumable-start',
        request: { method: 'POST', bucket: BUCKET, query: { name: 'big.bin' }, upload: { protocol: 'resumable', command: 'start' } },
        response: { status: 200, headers: { 'x-goog-upload-status': 'active', 'x-goog-upload-url': { $: 'uploadSession' } }, body: '' },
      },
      {
        kind: 'storage',
        id: 'resumable-chunk',
        request: { method: 'POST', bucket: BUCKET, query: { name: 'big.bin', upload_id: { $: 'uploadSession' }, upload_protocol: 'resumable' }, upload: { protocol: 'resumable', command: 'upload' } },
        response: { status: 200, headers: { 'x-goog-upload-status': 'active' }, body: '' },
      },
    ],
  };
  assertShapesOnly(session);
  const replay = await startReplayServer([session]);
  try {
    const start = await fetch(`${replay.origin}/v0/b/${BUCKET}/o?name=big.bin`, { method: 'POST', headers: { 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start' } });
    const uploadUrl = start.headers.get('x-goog-upload-url')!;
    expect(uploadUrl.startsWith(`${replay.origin}/v0/b/${BUCKET}/o?name=big.bin&upload_id=replay-upload-`)).toBe(true);
    const chunk = { method: 'POST', headers: { 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'upload' }, body: 'x' };
    expect((await fetch(uploadUrl, chunk)).status).toBe(200);
    const forged = uploadUrl.replace(/upload_id=[^&]+/, 'upload_id=not-issued');
    expect((await fetch(forged, chunk)).status).toBe(400);
    expect(replay.unmatched).toHaveLength(1);
  } finally {
    await replay.close();
  }
});
