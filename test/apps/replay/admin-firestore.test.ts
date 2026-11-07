/**
 * The real `firebase-admin/firestore`, from this checkout's node_modules,
 * reads, queries, counts, writes, runs transactions and listens against the
 * replay server over gRPC, in a `node` process of its own. It reaches the
 * server through its own `FIRESTORE_EMULATOR_HOST`, the app's config, so it
 * sends plaintext gRPC with `Authorization: Bearer owner` and looks up no
 * credential. Every answer comes from `fixtures/admin-minimal.json`, and a
 * call no exchange holds still fails closed and is listed in `unmatched`.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/admin-firestore.test.ts'`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { AdminFirestore } from './admin-firestore.ts';
import { ReplayState } from './firestore.ts';
import { assertShapesOnly, readRecording, type JsonObject, type Recording } from './format.ts';
import { startReplayProcess, unmatchedBy, type ReplayProcess } from './process.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const FIXTURE = join(import.meta.dir, 'fixtures', 'admin-minimal.json');
const DATABASE = 'projects/pyric-replay-admin/databases/(default)';
let server: ReplayProcess;

beforeAll(async () => {
  server = await startReplayProcess([FIXTURE], ROOT);
});

afterAll(async () => {
  await server.stop();
});

/** The Admin app: each step's answer, as the SDK hands it to the app. */
const CLIENT = `
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
const db = getFirestore(initializeApp({ projectId: 'pyric-replay-admin' }));
const notes = db.collection('notes');
const codeOf = (pending) => pending.then(() => 'ok', (error) => error.code);
const out = {};
await notes.doc('a').set({ n: 1, title: 'first' });
const a = await notes.doc('a').get();
out.read = { exists: a.exists, data: a.data() };
out.missing = (await notes.doc('missing').get()).exists;
await notes.doc('a').update({ n: 2 });
out.updateMissing = await codeOf(notes.doc('missing').update({ n: 1 }));
out.createExisting = await codeOf(notes.doc('a').create({ n: 3 }));
out.addedIdLength = (await notes.add({ n: 4 })).id.length;
const batch = db.batch();
batch.set(notes.doc('b'), { n: 5 });
batch.delete(notes.doc('c'));
out.batched = (await batch.commit()).length;
out.queried = (await notes.where('n', '>=', 5).get()).docs.map((doc) => [doc.id, doc.get('n')]);
out.counted = (await notes.count().get()).data().count;
out.gotAll = (await db.getAll(notes.doc('a'), notes.doc('missing'))).map((snapshot) => snapshot.exists);
out.transacted = await db.runTransaction(async (transaction) => {
  const snapshot = await transaction.get(notes.doc('a'));
  transaction.update(notes.doc('a'), { n: snapshot.get('n') + 1 });
  return snapshot.get('n');
});
out.rolledBack = await db.runTransaction(async (transaction) => {
  await transaction.get(notes.doc('b'));
  throw new Error('the app stopped');
}).then(() => 'committed', (error) => error.message);
out.listened = await new Promise((done, fail) => {
  const seen = [];
  const stop = notes.where('n', '>=', 5).onSnapshot((snapshot) => {
    seen.push(snapshot.docs.map((doc) => doc.id));
    if (seen.length === 1) void notes.doc('d').set({ n: 6 });
    if (seen.length === 2) { stop(); done(seen); }
  }, fail);
});
await notes.doc('a').delete();
out.unrecorded = await codeOf(notes.doc('unrecorded').set({ n: 0 }));
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
`;

/** Runs the Admin app to exit against the replay's gRPC host. */
function runAdmin(grpcHost: string): Promise<{ stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, FIRESTORE_EMULATOR_HOST: grpcHost };
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.FIRESTORE_PREFER_REST;
  return new Promise((done) => {
    const child = spawn('node', ['--input-type=module', '-e', CLIENT], { cwd: ROOT, env, timeout: 60_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (part: Buffer) => { stdout += part.toString(); });
    child.stderr.on('data', (part: Buffer) => { stderr += part.toString(); });
    child.on('close', () => done({ stdout, stderr }));
  });
}

test('the Admin SDK reads, queries, counts, writes, transacts and listens over gRPC from the recording, and an unrecorded write fails closed', async () => {
  const run = await runAdmin(server.grpc!);
  const line = run.stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
  expect(line, `${run.stdout}\n${run.stderr}`).toBeDefined();
  expect(JSON.parse(line!.slice('RESULT '.length))).toEqual({
    read: { exists: true, data: { n: 1, title: 'first' } },
    missing: false,
    updateMissing: 5,
    createExisting: 6,
    addedIdLength: 20,
    batched: 2,
    queried: [['b', 5]],
    counted: 3,
    gotAll: [true, false],
    transacted: 2,
    rolledBack: 'the app stopped',
    listened: [['b'], ['b', 'd']],
    unrecorded: 9,
  });
  expect(await unmatchedBy(server.origin)).toEqual([{ rpc: 'grpc', as: null, request: { method: 'Commit' } }]);
}, 90_000);

/**
 * A client SDK app that sends the Admin SDK's bearer: the Node build of
 * `firebase/firestore` with `mockUserToken: 'owner'`. Its transaction
 * commits the write the fixture's `set-a` Commit holds. The client SDK sends
 * no RunQuery over gRPC, so the query is a RunQuery with the client SDK's
 * own headers and the request the fixture's `query-n` holds, sent with the
 * grpc-js and protos that SDK carries.
 */
const CLIENT_AS_OWNER = `
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase/app';
import { connectFirestoreEmulator, doc, getFirestore, runTransaction } from 'firebase/firestore';
const { firestoreProtos } = await import(${JSON.stringify(join(import.meta.dir, 'grpc.ts'))});
const [grpcHost] = process.argv.slice(1);
const [host, port] = grpcHost.split(':');
const db = getFirestore(initializeApp({ projectId: 'pyric-replay-admin', apiKey: 'test-api-key', appId: '1:1:web:replay' }));
connectFirestoreEmulator(db, host, Number(port), { mockUserToken: 'owner' });
const out = {};
out.committed = await runTransaction(db, async (transaction) => {
  transaction.set(doc(db, 'notes/a'), { n: 1, title: 'first' });
}).then(() => 'ok', (error) => error.code);

const fromFirebase = createRequire(createRequire(join(process.cwd(), 'package.json')).resolve('firebase/firestore'));
const firestoreEntry = fromFirebase.resolve('@firebase/firestore');
const fromFirestore = createRequire(firestoreEntry);
const grpc = fromFirestore('@grpc/grpc-js');
const protobuf = createRequire(fromFirestore.resolve('@grpc/proto-loader'))('protobufjs');
const root = protobuf.Root.fromJSON(firestoreProtos(dirname(firestoreEntry)));
const Request = root.lookupType('google.firestore.v1.RunQueryRequest');
const Response = root.lookupType('google.firestore.v1.RunQueryResponse');
const metadata = new grpc.Metadata();
metadata.set('authorization', 'Bearer owner');
metadata.set('x-goog-api-client', 'gl-node/' + process.versions.node + ' fire/12.19.0 grpc/1.9.16');
const request = Request.fromObject({
  parent: 'projects/pyric-replay-admin/databases/(default)/documents',
  structuredQuery: { from: [{ collectionId: 'notes' }], where: { fieldFilter: { field: { fieldPath: 'n' }, op: 'GREATER_THAN_OR_EQUAL', value: { integerValue: 5 } } } },
});
const client = new grpc.Client(grpcHost, grpc.credentials.createInsecure());
out.queried = await new Promise((done) => {
  const names = [];
  const stream = client.makeServerStreamRequest('/google.firestore.v1.Firestore/RunQuery', (message) => Buffer.from(Request.encode(message).finish()), (bytes) => Response.decode(bytes), request, metadata);
  stream.on('data', (response) => { if (response.document) names.push(response.document.name.split('/').pop()); });
  stream.on('error', (error) => done(error.code));
  stream.on('end', () => done(names));
});
client.close();
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
`;

test('a client SDK call that sends the Admin bearer is refused, not answered from an Admin exchange', async () => {
  const replay = await startReplayProcess([FIXTURE], ROOT);
  try {
    const run = await new Promise<{ stdout: string; stderr: string }>((done) => {
      const child = spawn('node', ['--experimental-transform-types', '--no-warnings', '--input-type=module', '-e', CLIENT_AS_OWNER, replay.grpc!], { cwd: ROOT, timeout: 60_000 });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (part: Buffer) => { stdout += part.toString(); });
      child.stderr.on('data', (part: Buffer) => { stderr += part.toString(); });
      child.on('close', () => done({ stdout, stderr }));
    });
    const line = run.stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
    expect(line, `${run.stdout}\n${run.stderr}`).toBeDefined();
    expect(JSON.parse(line!.slice('RESULT '.length))).toEqual({ committed: 'unimplemented', queried: 12 });
    expect((await unmatchedBy(replay.origin)).map((entry) => entry.request)).toEqual([{ method: 'Commit' }, { method: 'RunQuery' }]);
  } finally {
    await replay.stop();
  }
}, 90_000);

/** A fresh replay state for the fixture, with its Admin answerer. */
function adminReplay(): { state: ReplayState; admin: AdminFirestore } {
  const state = new ReplayState([readRecording(FIXTURE)]);
  return { state, admin: new AdminFirestore(state) };
}

const COMMIT_IN_TRANSACTION: JsonObject = {
  database: DATABASE,
  writes: [{
    update: { name: `${DATABASE}/documents/notes/a`, fields: { n: { integerValue: '3' } } },
    updateMask: { fieldPaths: ['n'] },
    currentDocument: { exists: true },
  }],
};

test('a transaction BeginTransaction issues is matched once by its commit, and an id it never issued is unmatched', () => {
  const { state, admin } = adminReplay();
  const begun = admin.answer('BeginTransaction', { database: DATABASE, options: { readWrite: {} } });
  const transaction = begun?.responses[0]?.transaction;
  expect(typeof transaction).toBe('string');
  const committed = admin.answer('Commit', { ...COMMIT_IN_TRANSACTION, transaction: transaction! });
  expect(committed?.responses[0]?.writeResults).toBeDefined();
  expect(admin.answer('Commit', { ...COMMIT_IN_TRANSACTION, transaction: transaction! })).toBeNull();
  expect(admin.answer('Commit', { ...COMMIT_IN_TRANSACTION, transaction: Buffer.from('not issued').toString('base64') })).toBeNull();
  expect(state.unmatched.map((entry) => entry.request)).toEqual([{ method: 'Commit' }, { method: 'Commit' }]);
});

test('an Admin exchange whose transaction is a recorded value, not the placeholder, is refused', () => {
  const recording: Recording = {
    format: 'pyric-replay/1',
    project: 'pyric-replay-admin',
    source: 'hand-written',
    exchanges: [{ kind: 'admin-firestore', id: 'leak', rpc: 'Rollback', request: { database: DATABASE, transaction: 'cmVjb3JkZWQ=' }, responses: [{}] }],
  };
  expect(() => assertShapesOnly(recording)).toThrow('transaction must be one of the placeholders');
});

/** A recording where `add` creates a document whose id the SDK picks, read back by `getAll`. */
function autoIdReplay(): { state: ReplayState; admin: AdminFirestore } {
  const parent = `${DATABASE}/documents/notes`;
  const added = { $: 'autoId', name: 'add-1', parent };
  const recording: Recording = {
    format: 'pyric-replay/1',
    project: 'pyric-replay-admin',
    source: 'hand-written',
    exchanges: [
      { kind: 'admin-firestore', id: 'add', rpc: 'Commit', request: { database: DATABASE, writes: [{ update: { name: added, fields: {} }, currentDocument: { exists: false } }] }, responses: [{ writeResults: [{}], commitTime: { $: 'commitTime' } }] },
      { kind: 'admin-firestore', id: 'read', rpc: 'BatchGetDocuments', request: { database: DATABASE, documents: [added] }, responses: [{ found: { name: added, fields: {} }, readTime: { $: 'readTime' } }] },
    ],
  };
  const state = new ReplayState([recording]);
  return { state, admin: new AdminFirestore(state) };
}

function addCommit(id: string): JsonObject {
  return { database: DATABASE, writes: [{ update: { name: `${DATABASE}/documents/notes/${id}`, fields: {} }, currentDocument: { exists: false } }] };
}

test('the id the SDK picks for add is kept, so a later read names it and another id is unmatched', () => {
  const { state, admin } = autoIdReplay();
  const id = 'Ab3dEf6hIj9lMn2pQr5t';
  expect(admin.answer('Commit', addCommit(id))).not.toBeNull();
  const read = admin.answer('BatchGetDocuments', { database: DATABASE, documents: [`${DATABASE}/documents/notes/${id}`] });
  expect((read?.responses[0]?.found as JsonObject | undefined)?.name).toBe(`${DATABASE}/documents/notes/${id}`);
  expect(admin.answer('BatchGetDocuments', { database: DATABASE, documents: [`${DATABASE}/documents/notes/Zz3dEf6hIj9lMn2pQr5t`] })).toBeNull();
  expect(state.unmatched.map((entry) => entry.request)).toEqual([{ method: 'BatchGetDocuments' }]);
});

test('an add whose id is not one the SDK could pick is unmatched, and keeps nothing', () => {
  const { state, admin } = autoIdReplay();
  expect(admin.answer('Commit', addCommit('short'))).toBeNull();
  expect(state.autoIds.size).toBe(0);
});

test('an autoId placeholder whose parent is outside the project is refused', () => {
  const recording: Recording = {
    format: 'pyric-replay/1',
    project: 'pyric-replay-admin',
    source: 'hand-written',
    exchanges: [{ kind: 'admin-firestore', id: 'add', rpc: 'Commit', request: { database: DATABASE, writes: [{ update: { name: { $: 'autoId', name: 'add-1', parent: 'projects/other/databases/(default)/documents/notes' } } }] }, responses: [{}] }],
  };
  expect(() => assertShapesOnly(recording)).toThrow('outside project pyric-replay-admin');
});
