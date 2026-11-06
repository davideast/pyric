/**
 * The real `firebase-admin/auth`, from this checkout's node_modules, creates,
 * reads, updates, lists and deletes users and verifies an ID token against
 * the replay server, in a `node` process of its own. It reaches the server
 * through its own `FIREBASE_AUTH_EMULATOR_HOST`, the app's config, so it
 * sends `Authorization: Bearer owner` and looks up no credential. Every
 * answer comes from `fixtures/admin-minimal.json`, and a call no exchange
 * holds still fails closed and is listed in `unmatched`.
 *
 * With those Admin exchanges loaded, a Firestore Commit or RunQuery shaped as
 * a client SDK sends it (a bearer that is not `owner`) is still refused: an
 * Admin exchange answers only the Admin SDK.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/admin-auth.test.ts'`.
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

/** The Admin app: each step's answer, as the SDK hands it to the app. */
const ADMIN_APP = `
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
const auth = getAuth(initializeApp({ projectId: 'pyric-replay-admin' }));
const codeOf = (pending) => pending.then(() => 'ok', (error) => error.code);
const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const claims = { iss: 'https://securetoken.google.com/pyric-replay-admin', aud: 'pyric-replay-admin', auth_time: now, user_id: 'user-a', sub: 'user-a', iat: now, exp: now + 3600, firebase: { identities: {}, sign_in_provider: 'password' } };
const emulatorToken = segment({ alg: 'none', typ: 'JWT' }) + '.' + segment(claims) + '.';
const out = {};
const created = await auth.createUser({ uid: 'user-a', email: 'a@example.com', password: 'test-password' });
out.created = { uid: created.uid, email: created.email };
out.read = (await auth.getUser('user-a')).displayName ?? null;
out.byEmail = (await auth.getUserByEmail('a@example.com')).uid;
await auth.setCustomUserClaims('user-a', { role: 'capture' });
out.updated = (await auth.updateUser('user-a', { displayName: 'Capture' })).displayName;
out.verified = (await auth.verifyIdToken(emulatorToken, true)).uid;
out.listed = (await auth.listUsers()).users.map((user) => [user.uid, user.customClaims ?? null]);
out.deletedMany = (await auth.deleteUsers(['user-b', 'user-c'])).successCount;
await auth.deleteUser('user-a');
out.afterDelete = await codeOf(auth.getUser('user-a'));
out.unrecorded = await codeOf(auth.getUser('user-unrecorded'));
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
`;

/**
 * A client-shaped Commit and RunQuery: the bearer a signed-in client SDK
 * sends, not the Admin SDK's \`owner\`. Each request is empty; an Admin call
 * no exchange holds would get FAILED_PRECONDITION, so UNIMPLEMENTED shows the
 * call was refused before any Admin exchange was tried.
 */
const CLIENT_SHAPED = `
import { createRequire } from 'node:module';
const fromRoot = createRequire(process.cwd() + '/package.json');
const fromFirestore = createRequire(createRequire(fromRoot.resolve('firebase/firestore')).resolve('@firebase/firestore'));
const grpc = fromFirestore('@grpc/grpc-js');
const host = process.argv[1];
const client = new grpc.Client(host, grpc.credentials.createInsecure());
const metadata = new grpc.Metadata();
metadata.set('authorization', 'Bearer client-id-token');
const bytes = (value) => value;
const out = {};
out.commit = await new Promise((done) => client.makeUnaryRequest('/google.firestore.v1.Firestore/Commit', bytes, bytes, Buffer.alloc(0), metadata, (error) => done(error ? error.code : 'answered')));
out.runQuery = await new Promise((done) => {
  const call = client.makeServerStreamRequest('/google.firestore.v1.Firestore/RunQuery', bytes, bytes, Buffer.alloc(0), metadata);
  call.on('data', () => {});
  call.on('error', (error) => done(error.code));
  call.on('end', () => done('answered'));
});
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
`;

/** Runs app code in `node` to exit with `env`, and returns its RESULT line's value. */
function runNode(code: string, args: string[], env: Record<string, string | undefined>): Promise<unknown> {
  return new Promise((done, fail) => {
    const child = spawn('node', ['--input-type=module', '-e', code, ...args], { cwd: ROOT, env, timeout: 60_000 });
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
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.FIRESTORE_EMULATOR_HOST;
  return env;
}

test('the Admin SDK creates, reads, updates, verifies, lists and deletes users from the recording, and an unrecorded call fails closed', async () => {
  const before = (await unmatchedBy(server.origin)).length;
  const authHost = new URL(server.origin).host;
  const result = await runNode(ADMIN_APP, [], { ...bareEnv(), FIREBASE_AUTH_EMULATOR_HOST: authHost });
  expect(result).toEqual({
    created: { uid: 'user-a', email: 'a@example.com' },
    read: null,
    byEmail: 'user-a',
    updated: 'Capture',
    verified: 'user-a',
    listed: [['user-a', { role: 'capture' }]],
    deletedMany: 2,
    afterDelete: 'auth/user-not-found',
    unrecorded: 'auth/internal-error',
  });
  const unmatched = (await unmatchedBy(server.origin)).slice(before);
  expect(unmatched).toEqual([{
    rpc: 'auth',
    as: null,
    request: { method: 'POST', path: '/v1/projects/pyric-replay-admin/accounts:lookup', body: { localId: ['user-unrecorded'] } },
  }]);
}, 90_000);

test('with Admin exchanges loaded, a client-shaped Commit and RunQuery are refused and listed', async () => {
  const before = (await unmatchedBy(server.origin)).length;
  const result = await runNode(CLIENT_SHAPED, [server.grpc!], bareEnv());
  expect(result).toEqual({ commit: 12, runQuery: 12 });
  const unmatched = (await unmatchedBy(server.origin)).slice(before);
  expect(unmatched).toEqual([
    { rpc: 'grpc', as: null, request: { method: 'Commit' } },
    { rpc: 'grpc', as: null, request: { method: 'RunQuery' } },
  ]);
}, 90_000);
