/**
 * The Admin Firestore row over the real `@google-cloud/firestore`, the copy
 * firebase-admin loads, against the replay's in-process gRPC server
 * (`test/apps/replay/grpc.ts`) through the SDK's own
 * `FIRESTORE_EMULATOR_HOST`. Every call crosses real gRPC and gets the
 * answers `fixtures/admin-minimal.json` holds. Each record must name the
 * class and method, the path, `sdk: 'admin'` and production's code in the
 * client SDK's spelling, and carry no document data. A Firestore on another
 * project is refused by the project gate before any request, and
 * `admin.firestore()` reaches the same patched classes.
 *
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/admin-firestore-row.test.ts'`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { observedCallOf } from '../src/page-observer.js';
import { adminProjectGate } from '../src/admin/project-gate.js';
import { ADMIN_FIRESTORE_MODULE, observeAdminFirestore } from '../src/admin/firestore.js';
import type { LiveCallRecord, LiveObserver } from '../src/observe.js';

/** The replay state `test/apps/replay/firestore.ts` defines: the part this test reads. */
interface ReplayState {
  readonly unmatched: unknown[];
}

/** The replay helpers this test uses from `test/apps/replay/`. */
interface Replay {
  readRecording(path: string): object;
  ReplayState: new (recordings: object[]) => ReplayState;
  startGrpcReplay(state: ReplayState, projectDir: string): Promise<{ host: string; close(): void }>;
}

/**
 * Loads the replay helpers at run time. They import their siblings with a
 * `.ts` extension, which this package's typecheck does not take, so they stay
 * out of it and this test declares the part it uses.
 */
async function loadReplay(): Promise<Replay> {
  const load = (name: string) => import(new URL(`../../../test/apps/replay/${name}.ts`, import.meta.url).href);
  const [format, firestore, grpc] = await Promise.all([load('format'), load('firestore'), load('grpc')]);
  return { ...format, ...firestore, ...grpc } as Replay;
}

const PROJECT = 'pyric-replay-admin';
const ROOT = new URL('../../../', import.meta.url).pathname;
const FIXTURE = new URL('../../../test/apps/replay/fixtures/admin-minimal.json', import.meta.url).pathname;

type AnyFunction = (...args: unknown[]) => unknown;
type Instance = Record<string, AnyFunction> & Record<string, unknown>;
interface FirestoreSdk {
  Firestore: new (settings: object) => Instance;
  DocumentReference: { prototype: Record<string, AnyFunction> };
  DocumentSnapshot: new (...args: unknown[]) => unknown;
}

const fromAdmin = createRequire(createRequire(import.meta.url).resolve('firebase-admin/firestore'));
const ENTRY = fromAdmin.resolve('@google-cloud/firestore');
const sdk = fromAdmin('@google-cloud/firestore') as FirestoreSdk;
const realGet = sdk.DocumentReference.prototype.get!;

const records: LiveCallRecord[] = [];
const lines: string[] = [];
const observer: LiveObserver = (record) => {
  records.push(record);
};
let replay: Replay;
let state: ReplayState;
let server: { host: string; close(): void };
let db: Instance;

beforeAll(async () => {
  replay = await loadReplay();
  state = new replay.ReplayState([replay.readRecording(FIXTURE)]);
  server = await replay.startGrpcReplay(state, ROOT);
  process.env.FIRESTORE_EMULATOR_HOST = server.host;
  observeAdminFirestore(sdk, ENTRY, { observer, gate: adminProjectGate(PROJECT, (line) => lines.push(line), {}) });
  db = new sdk.Firestore({ projectId: PROJECT });
});

afterAll(async () => {
  await (db?.terminate as AnyFunction | undefined)?.call(db);
  server?.close();
  delete process.env.FIRESTORE_EMULATOR_HOST;
});

/** The records made since `from`, once the microtasks that make them have run. */
async function recordsSince(from: number): Promise<LiveCallRecord[]> {
  await new Promise((done) => setTimeout(done, 10));
  return records.slice(from);
}

function doc(path: string, firestore: Instance = db): Instance {
  return (firestore.doc as AnyFunction).call(firestore, path) as Instance;
}

function codeOf(pending: unknown): Promise<unknown> {
  return (pending as Promise<unknown>).then(() => 'ok', (error: { code?: unknown }) => error.code);
}

test('the patched method keeps its name and length, and patching twice changes nothing', () => {
  const patched = sdk.DocumentReference.prototype.get!;
  expect(patched).not.toBe(realGet);
  expect(patched.name).toBe(realGet.name);
  expect(patched.length).toBe(realGet.length);
  observeAdminFirestore(sdk, ENTRY, { observer, gate: adminProjectGate(PROJECT, () => undefined, {}) });
  expect(sdk.DocumentReference.prototype.get).toBe(patched);
});

test('DocumentReference.get makes one record with its path and ok, and returns the SDK snapshot untouched', async () => {
  const from = records.length;
  const snapshot = (await doc('notes/a').get!()) as { exists: boolean; data(): unknown };
  expect(snapshot).toBeInstanceOf(sdk.DocumentSnapshot);
  expect(snapshot.exists).toBe(true);
  expect(snapshot.data()).toEqual({ n: 1, title: 'first' });
  const made = await recordsSince(from);
  expect(made).toEqual([{ module: ADMIN_FIRESTORE_MODULE, name: 'DocumentReference.get', outcome: 'resolved', sdk: 'admin', projectId: PROJECT, path: 'notes/a' }]);
  expect(observedCallOf(made[0]!, 1)).toMatchObject({ service: 'firestore', method: 'DocumentReference.get', sdk: 'admin', path: 'notes/a', outcome: { status: 'ok' } });
});

test('an update of a missing document records not-found, and a create of an existing one already-exists', async () => {
  const from = records.length;
  expect(await codeOf(doc('notes/missing').update!({ n: 1 }))).toBe(5);
  expect(await codeOf(doc('notes/a').create!({ n: 3 }))).toBe(6);
  const made = await recordsSince(from);
  expect(made.map(({ name, outcome, code, path }) => ({ name, outcome, code, path }))).toEqual([
    { name: 'DocumentReference.update', outcome: 'rejected', code: 'not-found', path: 'notes/missing' },
    { name: 'DocumentReference.create', outcome: 'rejected', code: 'already-exists', path: 'notes/a' },
  ]);
  expect(observedCallOf(made[0]!, 1)?.outcome).toEqual({ status: 'error', code: 'not-found', message: '5 NOT_FOUND: No document to update: projects/pyric-replay-admin/databases/(default)/documents/notes/missing' });
});

test('Query.onSnapshot makes one record per delivery, each with its billed documents', async () => {
  const from = records.length;
  const query = ((db.collection as AnyFunction).call(db, 'notes') as Instance).where!('n', '>=', 5) as Instance;
  const seen = await new Promise<string[][]>((done, fail) => {
    const delivered: string[][] = [];
    const stop = query.onSnapshot!((snapshot: { docs: { id: string }[] }) => {
      delivered.push(snapshot.docs.map((entry) => entry.id));
      if (delivered.length === 1) void doc('notes/d').set!({ n: 6 });
      if (delivered.length === 2) {
        (stop as () => void)();
        done(delivered);
      }
    }, fail) as () => void;
    expect(typeof stop).toBe('function');
  });
  expect(seen).toEqual([['b'], ['b', 'd']]);
  const made = await recordsSince(from);
  const listened = made.filter((record) => record.name === 'Query.onSnapshot');
  expect(listened.map(({ outcome, billedDocuments, path }) => ({ outcome, billedDocuments, path }))).toEqual([
    { outcome: 'returned', billedDocuments: undefined, path: 'notes' },
    { outcome: 'delivered', billedDocuments: 1, path: 'notes' },
    { outcome: 'delivered', billedDocuments: 1, path: 'notes' },
  ]);
  expect(listened.map((record) => observedCallOf(record, 1)?.outcome ?? null)).toEqual([null, { status: 'ok' }, { status: 'ok' }]);
  expect(made.filter((record) => record.name === 'DocumentReference.set')).toHaveLength(1);
});

test('Query.get records its billed documents, and AggregateQuery.get its collection', async () => {
  const from = records.length;
  const notes = (db.collection as AnyFunction).call(db, 'notes') as Instance;
  const queried = (await (notes.where!('n', '>=', 5) as Instance).get!()) as { size: number };
  expect(queried.size).toBe(1);
  await (notes.count!() as Instance).get!();
  const made = await recordsSince(from);
  expect(made.map(({ name, outcome, billedDocuments, path }) => ({ name, outcome, billedDocuments, path }))).toEqual([
    { name: 'Query.get', outcome: 'resolved', billedDocuments: 1, path: 'notes' },
    { name: 'AggregateQuery.get', outcome: 'resolved', billedDocuments: undefined, path: 'notes' },
  ]);
});

test('a Firestore on another project is refused by the gate before any request, with no record', async () => {
  const from = records.length;
  const other = new sdk.Firestore({ projectId: 'other-project' });
  const error = (await (doc('notes/a', other).get!() as Promise<unknown>).catch((reason: unknown) => reason)) as { code?: string };
  expect(error.code).toBe('PYRIC_LIVE_REFUSED');
  // A count query reaches its Firestore through its query, and is gated on it too.
  const counted = ((other.collection as AnyFunction).call(other, 'notes') as Instance).count!() as Instance;
  const countError = (await (counted.get!() as Promise<unknown>).catch((reason: unknown) => reason)) as { code?: string };
  expect(countError.code).toBe('PYRIC_LIVE_REFUSED');
  expect(await recordsSince(from)).toEqual([]);
  expect(state.unmatched).toEqual([]);
  expect(lines).toHaveLength(1);
  await (other.terminate as AnyFunction).call(other);
});

/** Runs `run` with `GOOGLE_CLOUD_PROJECT` set to `projectId`, the project google-auth works out for an app with none of its own. */
async function withDetectedProject<T>(projectId: string, run: () => Promise<T>): Promise<T> {
  const before = process.env.GOOGLE_CLOUD_PROJECT;
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = before;
  }
}

test('a Firestore with no project is gated on the project it works out: refused for another, allowed for the host', async () => {
  const from = records.length;
  const elsewhere = new sdk.Firestore({});
  const error = await withDetectedProject('other-prod', () => (doc('notes/a', elsewhere).get!() as Promise<unknown>).catch((reason: unknown) => reason));
  expect((error as { code?: string }).code).toBe('PYRIC_LIVE_REFUSED');
  expect(state.unmatched).toEqual([]);
  expect(await recordsSince(from)).toEqual([]);
  await (elsewhere.terminate as AnyFunction).call(elsewhere);

  const here = new sdk.Firestore({});
  const snapshot = await withDetectedProject(PROJECT, () => doc('notes/a', here).get!() as Promise<{ exists: boolean }>);
  expect(snapshot.exists).toBe(true);
  expect((await recordsSince(from)).map(({ name, path }) => ({ name, path }))).toEqual([{ name: 'DocumentReference.get', path: 'notes/a' }]);
  await (here.terminate as AnyFunction).call(here);
});

test('inside a runTransaction callback, a plain get makes its own record, and another project is refused before any request', async () => {
  const from = records.length;
  const other = new sdk.Firestore({ projectId: 'other-project' });
  const inside = await (db.runTransaction as AnyFunction).call(db, async () => {
    await doc('notes/a').get!();
    return codeOf(doc('notes/a', other).get!());
  });
  expect(inside).toBe('PYRIC_LIVE_REFUSED');
  const made = await recordsSince(from);
  expect(made.map(({ name, outcome }) => ({ name, outcome }))).toEqual([
    { name: 'DocumentReference.get', outcome: 'resolved' },
    { name: 'Firestore.runTransaction', outcome: 'resolved' },
  ]);
  expect(state.unmatched).toEqual([]);
  await (other.terminate as AnyFunction).call(other);
});

test('a refused listener with no error callback logs the refusal with console.error, as the SDK logs a listener error', async () => {
  const other = new sdk.Firestore({ projectId: 'other-project' });
  const logged: unknown[] = [];
  const real = console.error;
  console.error = (...values: unknown[]) => void logged.push(values[0]);
  try {
    const stop = doc('notes/a', other).onSnapshot!(() => undefined) as () => void;
    await new Promise((done) => setTimeout(done, 20));
    stop();
  } finally {
    console.error = real;
  }
  expect(logged.map((value) => (value as { code?: string }).code)).toEqual(['PYRIC_LIVE_REFUSED']);
  expect(state.unmatched).toEqual([]);
  await (other.terminate as AnyFunction).call(other);
});

test('admin.firestore() and getFirestore() reach the same patched classes and make the same records', async () => {
  const admin = createRequire(import.meta.url)('firebase-admin') as { initializeApp(options: object, name: string): object; firestore(app: object): Instance };
  const { getFirestore } = createRequire(import.meta.url)('firebase-admin/firestore') as { getFirestore(app: object): Instance };
  const app = admin.initializeApp({ projectId: PROJECT }, 'admin-firestore-row');
  const from = records.length;
  await doc('notes/a', admin.firestore(app)).get!();
  await doc('notes/a', getFirestore(app)).get!();
  const made = await recordsSince(from);
  expect(made.map(({ name, sdk: madeBy, path }) => ({ name, sdk: madeBy, path }))).toEqual([
    { name: 'DocumentReference.get', sdk: 'admin', path: 'notes/a' },
    { name: 'DocumentReference.get', sdk: 'admin', path: 'notes/a' },
  ]);
});

test('an observer that measures gets each resolved call\'s usage as the client method it counts as, and the host gets it', async () => {
  type Measure = (module: string, method: string, value: unknown) => Record<string, number> | undefined;
  const { measureObservedUsage } = (await import(new URL('../../pyric/src/sandbox/internal/observed-usage.ts', import.meta.url).href)) as { measureObservedUsage: Measure };
  const measuring = observer as LiveObserver & { measure?: Measure };
  measuring.measure = measureObservedUsage;
  try {
    const from = records.length;
    await doc('notes/a').get!();
    const made = await recordsSince(from);
    expect(made.map(({ name, usage }) => ({ name, usage }))).toEqual([{ name: 'DocumentReference.get', usage: { documentReads: 1 } }]);
    expect(observedCallOf(made[0]!, 1)?.usage).toEqual({ documentReads: 1 });
  } finally {
    delete measuring.measure;
  }
});

test('no record carries document data, and nested SDK calls make no record of their own', () => {
  const text = JSON.stringify(records);
  expect(text).not.toContain('first');
  expect(records.some((record) => record.writeData !== undefined || record.document !== undefined)).toBe(false);
  expect(records.some((record) => record.name === 'Firestore.getAll' || record.name === 'WriteBatch.commit')).toBe(false);
  expect(state.unmatched).toEqual([]);
});
