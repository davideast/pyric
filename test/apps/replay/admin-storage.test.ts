/**
 * The real `firebase-admin/database` and `firebase-admin/storage`, from this
 * checkout's node_modules, read and write against the replay server in a
 * `node` process of their own. They reach it through their own
 * `FIREBASE_DATABASE_EMULATOR_HOST` and `STORAGE_EMULATOR_HOST`, the app's
 * config, so the database connection authenticates with `gauth` as `owner`
 * and Storage sends no credential. Every answer comes from
 * `fixtures/admin-minimal.json`, and a call no exchange holds still fails
 * closed and is listed in `unmatched`.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/admin-storage.test.ts'`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { startReplayProcess, unmatchedBy, type ReplayProcess } from './process.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const FIXTURE = join(import.meta.dir, 'fixtures', 'admin-minimal.json');
let server: ReplayProcess;

beforeAll(async () => {
  server = await startReplayProcess([FIXTURE], ROOT);
});

afterAll(async () => {
  await server.stop();
});

/** Each step's answer, or its error, within 10 seconds: a step the replay never answers reads `timeout`. */
const STEP = `
const step = (pending) => Promise.race([
  pending.then((value) => (value === undefined ? 'ok' : value), (error) => 'error ' + (error.code ?? error.message.split(':')[0])),
  new Promise((done) => setTimeout(() => done('timeout'), 10_000)),
]);
`;

/** The Admin RTDB app: each step's answer, as the SDK hands it to the app. */
const RTDB_APP = `
import { initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
${STEP}
const app = initializeApp({ projectId: 'pyric-replay-admin', databaseURL: 'https://pyric-replay-admin-default-rtdb.firebaseio.com' });
const db = getDatabase(app);
const out = {};
out.set = await step(db.ref('notes/a').set({ n: 1, title: 'first' }));
out.get = await step(db.ref('notes/a').get().then((snapshot) => snapshot.val()));
out.update = await step(db.ref('notes/a').update({ n: 2 }));
out.push = await step(db.ref('notes').push({ n: 3 }).then((ref) => ref.parent.key));
out.missing = await step(db.ref('notes/missing').get().then((snapshot) => snapshot.val()));
out.remove = await step(db.ref('notes/a').remove());
out.unrecorded = await step(db.ref('unrecorded').set(1));
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
`;

/** The Admin Storage app: each step's answer, as the SDK hands it to the app. */
const STORAGE_APP = `
import { initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
${STEP}
const app = initializeApp({ projectId: 'pyric-replay-admin', storageBucket: 'pyric-replay-admin.firebasestorage.app' });
const bucket = getStorage(app).bucket();
const file = bucket.file('notes/a.txt');
const out = {};
out.saveMultipart = await step(file.save('hello replay', { resumable: false, contentType: 'text/plain' }));
out.saveResumable = await step(bucket.file('notes/b.txt').save('hello replay', { resumable: true, contentType: 'text/plain' }));
out.metadata = await step(file.getMetadata().then(([metadata]) => [metadata.size, metadata.contentType]));
out.exists = await step(file.exists().then(([exists]) => exists));
out.download = await step(file.download().then(([bytes]) => bytes.toString()));
out.list = await step(bucket.getFiles({ prefix: 'notes/' }).then(([files]) => files.map((each) => each.name)));
out.setMetadata = await step(file.setMetadata({ metadata: { role: 'capture' } }).then(([metadata]) => metadata.metadata));
out.missing = await step(bucket.file('notes/missing.txt').download());
out.delete = await step(file.delete().then(() => 'ok'));
out.unrecorded = await step(bucket.file('notes/unrecorded.txt').getMetadata());
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
`;

/** Runs app code in `node` to exit with `env`, and returns its RESULT line's value. */
function runNode(code: string, env: Record<string, string | undefined>): Promise<unknown> {
  return new Promise((done, fail) => {
    const child = spawn('node', ['--input-type=module', '-e', code], { cwd: ROOT, env, timeout: 120_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (part: Buffer) => { stdout += part.toString(); });
    child.stderr.on('data', (part: Buffer) => { stderr += part.toString(); });
    child.on('close', () => {
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
      if (line) done(JSON.parse(line.slice('RESULT '.length)));
      else fail(new Error(`no RESULT line:\n${stdout}\n${stderr}`));
    });
  });
}

/** The environment with no credential and no other emulator host. */
function bareEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) delete env[name];
  return env;
}

test('the Admin SDK authenticates to RTDB as owner, then sets, reads, updates, pushes and removes from the recording, and an unrecorded write fails closed', async () => {
  const before = (await unmatchedBy(server.origin)).length;
  const host = new URL(server.origin).host;
  const result = await runNode(RTDB_APP, { ...bareEnv(), FIREBASE_DATABASE_EMULATOR_HOST: host });
  expect(result).toEqual({
    set: 'ok',
    get: { n: 1, title: 'first' },
    update: 'ok',
    push: 'notes',
    missing: null,
    remove: 'ok',
    unrecorded: 'error PYRIC_REPLAY_NO_RECORDING',
  });
  const unmatched = (await unmatchedBy(server.origin)).slice(before);
  expect(unmatched).toEqual([{
    rpc: 'rtdb',
    as: 'owner',
    request: { instance: 'pyric-replay-admin-default-rtdb', a: 'p', b: { p: '/unrecorded', d: 1 } },
  }]);
}, 90_000);

test('the Admin SDK uploads, reads, lists, updates, downloads and deletes Storage objects from the recording, and an unrecorded call fails closed', async () => {
  const before = (await unmatchedBy(server.origin)).length;
  const result = await runNode(STORAGE_APP, { ...bareEnv(), STORAGE_EMULATOR_HOST: server.origin });
  expect(result).toEqual({
    saveMultipart: 'ok',
    saveResumable: 'ok',
    metadata: ['12', 'text/plain'],
    exists: true,
    download: 'hello replay',
    list: ['notes/a.txt', 'notes/b.txt'],
    setMetadata: { role: 'capture' },
    missing: 'error 404',
    delete: 'ok',
    unrecorded: 'error 400',
  });
  const unmatched = (await unmatchedBy(server.origin)).slice(before);
  expect(unmatched).toEqual([{
    rpc: 'http',
    as: null,
    request: { service: 'admin-storage', method: 'GET', path: '/b/pyric-replay-admin.firebasestorage.app/o/notes%2Funrecorded.txt', query: {} },
  }]);
}, 90_000);
