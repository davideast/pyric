/**
 * Capture A (Admin)'s run spec, the cases that recorded production, runs
 * again with the real firebase-admin against a replay server process started
 * with `--admin-capture`, and every case gets the answer production gave.
 * The app runs in a `node` process of its own and reaches the server through
 * firebase-admin's own emulator variables, so it sends no credential.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/admin-capture.test.ts'`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADMIN_CAPTURE_EMAIL, ADMIN_CAPTURE_RUN, adminCaptureFromText, CAPTURE_ADMIN, loadCaptureAdmin } from './admin-capture.ts';
import { assertShapesOnly } from './format.ts';
import { startReplayProcess, unmatchedBy, type ReplayProcess } from './process.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const PROJECT = 'pyric-admin-capture';
const CAPTURE_DIR = resolve(ROOT, 'packages/conformance/src/capture/admin-live');
let server: ReplayProcess;

beforeAll(async () => {
  server = await startReplayProcess([], ROOT, { adminCapture: PROJECT });
});

afterAll(async () => {
  await server.stop();
});

/**
 * The capture's own run spec and driver, with the capture's clients built
 * against the replay. The client sign-in (not recorded) becomes an unsigned
 * token for the created user. The document id `add` picks is the app's own,
 * which the replay keeps for the calls that name that document later.
 */
const APP = `
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
const { runSpec, drive } = await import(${JSON.stringify(`${CAPTURE_DIR}/capture-admin-wire.ts`)});
const { newStamp } = await import(${JSON.stringify(`${CAPTURE_DIR}/live-capture.ts`)});
const [project, runPath, email] = process.argv.slice(1);

const app = initializeApp({ projectId: project, databaseURL: 'https://' + project + '-default-rtdb.firebaseio.com', storageBucket: project + '.firebasestorage.app' });
const clients = { app, auth: getAuth(app), firestore: getFirestore(app), database: getDatabase(app), bucket: getStorage(app).bucket() };
const values = { ctx: { projectId: project }, runPath, email, password: 'replay-password', uid: '', idToken: '', closers: [], onSecret: () => {} };

const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const signIn = async () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://securetoken.google.com/' + project, aud: project, auth_time: now, iat: now, exp: now + 3600, sub: values.uid, user_id: values.uid };
  values.idToken = segment({ alg: 'none', typ: 'JWT' }) + '.' + segment(claims) + '.';
};
const steps = runSpec(clients, values).map((step) => (step.op === 'auth.clientSignIn' ? { ...step, run: signIn } : step));
const control = { signal: new AbortController().signal, track: () => {} };
const { results } = await drive(steps, newStamp(), async () => {}, control);
for (const close of values.closers) close();
console.log('RESULT ' + JSON.stringify(results));
process.exit(0);
`;

/** Runs the app in `node` with `env`, and returns its RESULT line's value. */
function runNode(args: string[], env: Record<string, string | undefined>): Promise<Record<string, string>> {
  return new Promise((done, fail) => {
    const child = spawn('node', ['--experimental-transform-types', '--no-warnings', '--input-type=module', '-e', APP, ...args], { cwd: ROOT, env, timeout: 240_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (part: Buffer) => { stdout += part.toString(); });
    child.stderr.on('data', (part: Buffer) => { stderr += part.toString(); });
    child.on('close', () => {
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
      if (line) done(JSON.parse(line.slice('RESULT '.length)) as Record<string, string>);
      else fail(new Error(`no RESULT line:\n${stdout}\n${stderr}`));
    });
  });
}

/** The environment with no credential, and each Admin service at the replay. */
function replayEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_STORAGE_EMULATOR_HOST']) delete env[name];
  const host = new URL(server.origin).host;
  return { ...env, FIRESTORE_EMULATOR_HOST: server.grpc!, FIREBASE_AUTH_EMULATOR_HOST: host, FIREBASE_DATABASE_EMULATOR_HOST: host, STORAGE_EMULATOR_HOST: server.origin };
}

/** The answers production gave, by case. */
function recordedAnswers(): Record<string, string> {
  return (JSON.parse(readFileSync(CAPTURE_ADMIN, 'utf8')) as { results: Record<string, string> }).results;
}

test('every case in capture A (Admin)\'s run spec gets the answer production gave, and nothing is unmatched', async () => {
  const results = await runNode([PROJECT, `pyric_oracle/${ADMIN_CAPTURE_RUN}`, ADMIN_CAPTURE_EMAIL], replayEnv());
  expect(results).toEqual(recordedAnswers());
  expect(await unmatchedBy(server.origin)).toEqual([]);
}, 300_000);

test('a hash placeholder no recorded upload hashes is refused, not filled with an empty hash', () => {
  const answer = (json: Record<string, string>) => ({ status: 200, headers: {}, body: { kind: 'json', json } });
  const upload = {
    seq: 1,
    service: 'storage',
    method: 'POST',
    path: '/upload/storage/v1/b/<bucket>/o',
    query: { uploadType: 'multipart', name: 'a.txt' },
    request: { contentType: 'multipart/related; boundary=<boundary>', body: { kind: 'text', text: '<boundary>\r\nContent-Type: application/json\r\n\r\n{}\r\n<boundary>\r\nContent-Type: text/plain\r\n\r\nhello\r\n<boundary>' } },
    response: answer({ md5Hash: '<md5-1>', crc32c: '<crc32c-1>' }),
  };
  const read = { ...upload, seq: 2, method: 'GET', path: '/storage/v1/b/<bucket>/o/a.txt', query: {}, request: { contentType: null, body: null } };
  const capture = (http: unknown[]) => JSON.stringify({ observedAt: 'test', adminVersion: 'test', grpc: [], http, rtdb: [] });
  const filled = adminCaptureFromText(PROJECT, capture([upload, read]));
  expect(filled.http[1]!.response.body).toEqual({ kind: 'json', json: { md5Hash: 'XUFAKrxLKna5cZ2REBfFkg==', crc32c: 'mnG7TA==' } });
  const unhashed = { ...read, response: answer({ md5Hash: '<md5-2>', crc32c: '<crc32c-1>' }) };
  expect(() => adminCaptureFromText(PROJECT, capture([upload, unhashed]))).toThrow('<md5-2>');
});

test('an Admin Storage exchange naming a bucket outside the project is refused, as every recording\'s are', () => {
  const recording = loadCaptureAdmin(PROJECT);
  const exchanges = recording.exchanges.map((exchange) => (exchange.kind === 'admin-storage' ? { ...exchange, request: { ...exchange.request, path: exchange.request.path.replace(`${PROJECT}.firebasestorage.app`, 'other-project.appspot.com') } } : exchange));
  expect(() => assertShapesOnly({ ...recording, exchanges })).toThrow('outside project pyric-admin-capture');
});
