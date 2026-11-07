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
}, 30_000);

test('a download of a missing object records storage/object-not-found, and the app gets the SDK error', async () => {
  const from = records.length;
  const error = (await (file('notes/missing.txt').download!() as Promise<unknown>).catch((reason: unknown) => reason)) as { code?: unknown };
  expect(error.code).toBe(404);
  const made = await recordsSince(from);
  expect(summary(made)).toEqual([{ name: 'File.download', outcome: 'rejected', code: 'storage/object-not-found', bucket: BUCKET, path: 'notes/missing.txt' }]);
  expect(observedCallOf(made[0]!, 1)?.outcome).toEqual({ status: 'error', code: 'storage/object-not-found' });
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

test('no record carries a token, password, email, object bytes or metadata value', () => {
  const text = JSON.stringify(records);
  for (const secret of ['hello replay', 'capture', 'owner', 'Bearer', 'token', 'password', 'text/plain']) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/[\w.-]+@[\w-]+\.[\w.]+/);
});
