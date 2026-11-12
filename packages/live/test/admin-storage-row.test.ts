/**
 * The Admin Storage row over the real `@google-cloud/storage`, the copy
 * firebase-admin loads, against the replay's Storage JSON API
 * (`test/apps/replay/admin-storage.ts`) in a replay process, through the
 * SDK's own `STORAGE_EMULATOR_HOST`. Every call crosses real HTTP and gets
 * the answers `fixtures/admin-minimal.json` holds. Each record must name the
 * class and method, the bucket and object name, `sdk: 'admin'` and
 * production's code in the client SDK's spelling (HTTP 404 is
 * `storage/object-not-found`), and carry no object bytes or metadata value.
 * A client on another project, explicit or worked out by the client itself,
 * is refused by the project gate before any request.
 *
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/admin-storage-row.test.ts'`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { observedCallOf } from '../src/page-observer.js';
import { sessionDataOf } from '../src/session-data.js';
import { adminProjectGate } from '../src/admin/project-gate.js';
import { ADMIN_STORAGE_MODULE, observeAdminStorage } from '../src/admin/storage.js';
import type { LiveCallRecord, LiveObserver } from '../src/observe.js';

/** The replay process helpers this test uses from `test/apps/replay/process.ts`. */
interface ReplayProcessModule {
  startReplayProcess(recordings: string[], grpcProjectDir?: string): Promise<{ origin: string; stop(): Promise<void> }>;
  receivedBy(origin: string): Promise<unknown[]>;
  unmatchedBy(origin: string): Promise<unknown[]>;
}

/**
 * Loads the replay helpers at run time. They import their siblings with a
 * `.ts` extension, which this package's typecheck does not take, so they stay
 * out of it and this test declares the part it uses.
 */
async function loadReplay(): Promise<ReplayProcessModule> {
  return (await import(new URL('../../../test/apps/replay/process.ts', import.meta.url).href)) as ReplayProcessModule;
}

const PROJECT = 'pyric-replay-admin';
const BUCKET = 'pyric-replay-admin.firebasestorage.app';
const ROOT = new URL('../../../', import.meta.url).pathname;
const FIXTURE = new URL('../../../test/apps/replay/fixtures/admin-minimal.json', import.meta.url).pathname;

type AnyFunction = (...args: unknown[]) => unknown;
type Instance = Record<string, AnyFunction> & Record<string, unknown>;
interface StorageSdk {
  Storage: new (options?: object) => Instance;
  File: { prototype: Record<string, AnyFunction> };
}
interface AdminApp {
  initializeApp(options: object, name: string): object;
}

const requireHere = createRequire(import.meta.url);
const fromAdmin = createRequire(requireHere.resolve('firebase-admin/storage'));
const ENTRY = fromAdmin.resolve('@google-cloud/storage');
const sdk = fromAdmin('@google-cloud/storage') as StorageSdk;
const realSave = sdk.File.prototype.save!;
const admin = requireHere('firebase-admin/app') as AdminApp;
const { getStorage } = requireHere('firebase-admin/storage') as { getStorage(app: object): { bucket(name?: string): Instance } };

const records: LiveCallRecord[] = [];
const lines: string[] = [];
const observer: LiveObserver = (record) => {
  records.push(record);
};
let replay: ReplayProcessModule;
let server: { origin: string; stop(): Promise<void> };
let bucket: Instance;
const projectBefore = process.env.GOOGLE_CLOUD_PROJECT;

beforeAll(async () => {
  replay = await loadReplay();
  server = await replay.startReplayProcess([FIXTURE], ROOT);
  process.env.STORAGE_EMULATOR_HOST = server.origin;
  // The project google-auth works out for an application-default app: the
  // gate reads it through the client's own `getProjectId`, not the env it is given.
  process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
  observeAdminStorage(sdk, ENTRY, { observer, gate: adminProjectGate(PROJECT, (line) => lines.push(line), {}) });
  const app = admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET }, 'admin-storage-row');
  bucket = getStorage(app).bucket();
}, 30_000);

afterAll(async () => {
  await server?.stop();
  delete process.env.STORAGE_EMULATOR_HOST;
  if (projectBefore === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
  else process.env.GOOGLE_CLOUD_PROJECT = projectBefore;
});

/** The records made since `from`, once the microtasks that make them have run. */
async function recordsSince(from: number): Promise<LiveCallRecord[]> {
  await new Promise((done) => setTimeout(done, 10));
  return records.slice(from);
}

function file(name: string, on: Instance = bucket): Instance {
  return (on.file as AnyFunction).call(on, name) as Instance;
}

function summary(made: readonly LiveCallRecord[]) {
  return made.map(({ name, outcome, code, bucket: madeIn, path }) => ({ name, outcome, code, bucket: madeIn, path }));
}

test('the patched method keeps its name and length, and patching twice changes nothing', () => {
  const patched = sdk.File.prototype.save!;
  expect(patched).not.toBe(realSave);
  expect(patched.name).toBe(realSave.name);
  expect(patched.length).toBe(realSave.length);
  observeAdminStorage(sdk, ENTRY, { observer, gate: adminProjectGate(PROJECT, () => undefined, {}) });
  expect(sdk.File.prototype.save).toBe(patched);
});

test('File and Bucket calls make one record each with the bucket and object name, and return the SDK answers untouched', async () => {
  const from = records.length;
  const notes = file('notes/a.txt');
  await notes.save!('hello replay', { resumable: false, contentType: 'text/plain' });
  await file('notes/b.txt').save!('hello replay', { resumable: true, contentType: 'text/plain' });
  const [metadata] = (await notes.getMetadata!()) as [{ size: string }];
  expect(metadata.size).toBe('12');
  expect(await notes.exists!()).toEqual([true]);
  const [bytes] = (await notes.download!()) as [Buffer];
  expect(bytes.toString()).toBe('hello replay');
  const [files] = (await bucket.getFiles!({ prefix: 'notes/' })) as [{ name: string }[]];
  expect(files.map((each) => each.name)).toEqual(['notes/a.txt', 'notes/b.txt']);
  await notes.setMetadata!({ metadata: { role: 'capture' } });
  await notes.delete!();
  const made = await recordsSince(from);
  const resolved = (name: string, path?: string) => ({ name, outcome: 'resolved' as const, code: undefined, bucket: BUCKET, path });
  expect(summary(made)).toEqual([
    resolved('File.save', 'notes/a.txt'),
    resolved('File.save', 'notes/b.txt'),
    resolved('File.getMetadata', 'notes/a.txt'),
    resolved('File.exists', 'notes/a.txt'),
    resolved('File.download', 'notes/a.txt'),
    resolved('Bucket.getFiles'),
    resolved('File.setMetadata', 'notes/a.txt'),
    resolved('File.delete', 'notes/a.txt'),
  ]);
  expect(made.every((record) => record.module === ADMIN_STORAGE_MODULE && record.sdk === 'admin')).toBe(true);
  expect(observedCallOf(made[4]!, 1)).toMatchObject({ service: 'storage', sdk: 'admin', method: 'File.download', bucket: BUCKET, path: 'notes/a.txt', outcome: { status: 'ok' } });
  expect(sessionDataOf(made[0]!)).toMatchObject({
    storage: [{ kind: 'upsert', bucket: BUCKET, fullPath: 'notes/a.txt', metadata: { size: 12, contentType: 'text/plain' } }],
  });
  expect(sessionDataOf(made[3]!)).toBeUndefined();
  expect(sessionDataOf(made[4]!)).toBeUndefined();
  expect(sessionDataOf(made[5]!)).toMatchObject({
    storage: [{ kind: 'list', bucket: BUCKET, prefix: 'notes', complete: true, recursive: true }],
  });
  expect(sessionDataOf(made[6]!)).toMatchObject({
    storage: [{ kind: 'upsert', bucket: BUCKET, fullPath: 'notes/a.txt', metadata: { customMetadata: { role: 'capture' } } }],
  });
  expect(sessionDataOf(made[7]!)).toEqual({
    storage: [{ kind: 'delete', bucket: BUCKET, fullPath: 'notes/a.txt' }],
  });
}, 30_000);

test('File.createWriteStream records one streaming upload with numeric byte length, and refuses wrong-project streams before any request', async () => {
  const from = records.length;
  const streamTarget = file('notes/a.txt');
  await new Promise<void>((resolve, reject) => {
    const ws = (streamTarget.createWriteStream as AnyFunction).call(streamTarget, {
      resumable: false,
      contentType: 'text/plain',
    }) as NodeJS.WritableStream;
    ws.on('finish', () => resolve());
    ws.on('error', reject);
    ws.end('hello replay');
  });
  const made = await recordsSince(from);
  expect(summary(made)).toEqual([
    { name: 'File.createWriteStream', outcome: 'resolved', code: undefined, bucket: BUCKET, path: 'notes/a.txt' },
  ]);
  expect(made[0]?.usage?.uploadedBytes).toBe(12);
  expect(sessionDataOf(made[0]!)).toMatchObject({
    storage: [
      {
        kind: 'upsert',
        bucket: BUCKET,
        fullPath: 'notes/a.txt',
        metadata: {
          size: 12,
          contentType: 'text/plain',
        },
      },
    ],
  });

  // Wrong-project stream is refused before any HTTP request leaves.
  const receivedBefore = (await replay.receivedBy(server.origin)).length;
  const otherBucket = (new sdk.Storage({ projectId: 'other-project' }).bucket as AnyFunction)(BUCKET) as Instance;
  const streamErr = await new Promise<{ code?: unknown }>((resolve) => {
    const ws = (file('notes/elsewhere.txt', otherBucket).createWriteStream as AnyFunction).call(
      file('notes/elsewhere.txt', otherBucket),
      { resumable: false },
    ) as NodeJS.WritableStream;
    ws.on('error', (err: { code?: unknown }) => resolve(err));
    ws.end('blocked');
  });
  expect(streamErr.code).toBe('PYRIC_LIVE_REFUSED');
  expect((await replay.receivedBy(server.origin)).length).toBe(receivedBefore);
}, 30_000);

test('a download of a missing object records storage/object-not-found, and the app gets the SDK error', async () => {
  const from = records.length;
  const error = (await (file('notes/missing.txt').download!() as Promise<unknown>).catch((reason: unknown) => reason)) as { code?: unknown };
  expect(error.code).toBe(404);
  const made = await recordsSince(from);
  expect(summary(made)).toEqual([{ name: 'File.download', outcome: 'rejected', code: 'storage/object-not-found', bucket: BUCKET, path: 'notes/missing.txt' }]);
  expect(observedCallOf(made[0]!, 1)?.outcome).toMatchObject({ status: 'error', code: 'storage/object-not-found' });
  expect(made[0]!.message).toContain('No such object');
}, 30_000);

/** Runs `run` with `GOOGLE_CLOUD_PROJECT` set to `projectId`, the project google-auth works out for an app with none of its own. */
async function withDetectedProject<T>(projectId: string, run: () => Promise<T>): Promise<T> {
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  try {
    return await run();
  } finally {
    process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
  }
}

async function refusalOf(pending: unknown): Promise<unknown> {
  return (pending as Promise<unknown>).then(() => 'ok', (error: { code?: unknown }) => error.code);
}

test('a client on another project is refused by the gate before any request, with no record', async () => {
  const from = records.length;
  const received = (await replay.receivedBy(server.origin)).length;
  const explicit = (new sdk.Storage({ projectId: 'other-project' }).bucket as AnyFunction)(BUCKET) as Instance;
  expect(await refusalOf(file('notes/elsewhere.txt', explicit).getMetadata!())).toBe('PYRIC_LIVE_REFUSED');
  const app = admin.initializeApp({ storageBucket: BUCKET }, 'admin-storage-elsewhere');
  const detected = await withDetectedProject('other-prod', async () => {
    const elsewhere = getStorage(app).bucket();
    return refusalOf(file('notes/elsewhere.txt', elsewhere).download!());
  });
  expect(detected).toBe('PYRIC_LIVE_REFUSED');
  expect(await recordsSince(from)).toEqual([]);
  expect((await replay.receivedBy(server.origin)).length).toBe(received);
  expect(await replay.unmatchedBy(server.origin)).toEqual([]);
  expect(lines).toHaveLength(1);
}, 30_000);

/** Calls `method` on `on` in the SDK's callback form, and resolves with the values its callback got. */
function viaCallback(on: Instance, method: string, ...args: unknown[]): Promise<unknown[]> {
  return new Promise((done) => {
    const returned = (on[method] as AnyFunction).call(on, ...args, (...values: unknown[]) => done(values));
    expect(returned).toBeUndefined();
  });
}

test('a call in the callback form is recorded when it settles, and its callback gets the SDK answer', async () => {
  const from = records.length;
  const notes = file('notes/a.txt');
  expect(await viaCallback(notes, 'save', 'hello replay', { resumable: false, contentType: 'text/plain' })).toEqual([null]);
  const [error, bytes] = await viaCallback(notes, 'download');
  expect(error).toBeNull();
  expect(String(bytes)).toBe('hello replay');
  const [missing] = (await viaCallback(file('notes/missing.txt'), 'download')) as [{ code?: unknown }];
  expect(missing.code).toBe(404);
  const made = await recordsSince(from);
  expect(summary(made)).toEqual([
    { name: 'File.save', outcome: 'resolved', code: undefined, bucket: BUCKET, path: 'notes/a.txt' },
    { name: 'File.download', outcome: 'resolved', code: undefined, bucket: BUCKET, path: 'notes/a.txt' },
    { name: 'File.download', outcome: 'rejected', code: 'storage/object-not-found', bucket: BUCKET, path: 'notes/missing.txt' },
  ]);
}, 30_000);

test('a refused call in the callback form gets the refusal in its callback, with no record or request', async () => {
  const from = records.length;
  const received = (await replay.receivedBy(server.origin)).length;
  const explicit = (new sdk.Storage({ projectId: 'other-project' }).bucket as AnyFunction)(BUCKET) as Instance;
  const [refusal] = (await viaCallback(file('notes/elsewhere.txt', explicit), 'download')) as [{ code?: unknown }];
  expect(refusal.code).toBe('PYRIC_LIVE_REFUSED');
  expect(await recordsSince(from)).toEqual([]);
  expect((await replay.receivedBy(server.origin)).length).toBe(received);
}, 30_000);

test('no record carries a token, password, email, object bytes or metadata value', () => {
  const text = JSON.stringify(records);
  for (const secret of ['hello replay', 'capture', 'owner', 'Bearer', 'token', 'password', 'text/plain']) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/[\w.-]+@[\w-]+\.[\w.]+/);
});

test('refuses cross-project buckets on File.createWriteStream, File.createReadStream, File.copy/move, Bucket.combine, and unreadable receivers before any request', async () => {
  const from = records.length;
  const receivedBefore = (await replay.receivedBy(server.origin)).length;
  const scopedObserver = observer as LiveObserver & { hostProjectId?: string; client?: 'node' };
  scopedObserver.hostProjectId = PROJECT;
  scopedObserver.client = 'node';
  try {
    const app = admin.initializeApp(
      { projectId: PROJECT, storageBucket: BUCKET },
      'admin-storage-cross-bucket',
    );
    const crossBucket = getStorage(app).bucket('other-project.appspot.com');
    const crossFile = file('notes/cross.txt', crossBucket);

    const writeStreamCode = await new Promise<string | undefined>((resolve) => {
      const ws = crossFile.createWriteStream!() as NodeJS.WritableStream;
      ws.on('error', (err: { code?: string }) => resolve(err.code));
      ws.on('finish', () => resolve('ok'));
      ws.end(Buffer.from('blocked'));
    });
    expect(writeStreamCode).toBe('PYRIC_LIVE_REFUSED');

    const readStreamCode = await new Promise<string | undefined>((resolve) => {
      const rs = crossFile.createReadStream!() as NodeJS.ReadableStream;
      rs.on('error', (err: { code?: string }) => resolve(err.code));
      rs.on('end', () => resolve('ok'));
      rs.resume();
    });
    expect(readStreamCode).toBe('PYRIC_LIVE_REFUSED');

    expect(await refusalOf(file('notes/a.txt').copy!(crossFile))).toBe('PYRIC_LIVE_REFUSED');
    expect(await refusalOf(file('notes/a.txt').move!('gs://other-project.firebasestorage.app/dest.txt'))).toBe(
      'PYRIC_LIVE_REFUSED',
    );
    expect(await refusalOf((bucket.combine as AnyFunction).call(bucket, [file('notes/a.txt')], crossFile))).toBe(
      'PYRIC_LIVE_REFUSED',
    );

    const orphanFile = Object.create(sdk.File.prototype) as Instance;
    expect(await refusalOf(orphanFile.save!('x'))).toBe('PYRIC_LIVE_REFUSED');

    expect(await recordsSince(from)).toEqual([]);
    expect((await replay.receivedBy(server.origin)).length).toBe(receivedBefore);
  } finally {
    delete scopedObserver.hostProjectId;
    delete scopedObserver.client;
  }
}, 30_000);
