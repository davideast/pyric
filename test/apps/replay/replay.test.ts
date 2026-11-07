/**
 * The real `firebase` web SDK, from this checkout's node_modules, signs in,
 * reads, listens and writes against the replay server as if it were talking
 * to production. Firestore is the browser build, so its Listen and Write
 * streams run over WebChannel as they do in a page. The app code below is
 * plain SDK code: only `routeFirebaseTo` points it at the replay server.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay'`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { FirebaseApp as App } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import { assertShapesOnly, readRecording, type Recording } from './format.ts';
import { routeFirebaseTo, rewrite } from './seam.ts';
import { loadSdk, type Sdk } from './sdk.ts';
import { startReplayServer, type ReplayServer } from './server.ts';

const ROOMS = join(import.meta.dir, 'fixtures', 'rooms.json');
const CONFIG = { projectId: 'demo-replay', apiKey: 'test-api-key', appId: '1:1:web:replay', authDomain: 'demo-replay.firebaseapp.com' };

let server: ReplayServer;
let stopRouting: () => void;
let sdk: Sdk;
let apps = 0;

beforeAll(async () => {
  server = await startReplayServer([readRecording(ROOMS)]);
  stopRouting = routeFirebaseTo(server.origin);
  sdk = await loadSdk();
});

afterAll(async () => {
  for (const app of sdk.app.getApps()) await sdk.app.deleteApp(app);
  stopRouting();
  await server.close();
});

afterEach(() => {
  server.unmatched.length = 0;
});

/** A fresh app signed in as the recorded reader, as the app under test would set itself up. */
async function signedInApp(settings: Record<string, unknown> = {}): Promise<{ app: App; db: Firestore }> {
  apps += 1;
  const app = sdk.app.initializeApp(CONFIG, `replay-${apps}`);
  const auth = sdk.auth.getAuth(app);
  await sdk.auth.signInWithEmailAndPassword(auth, 'reader@example.com', 'test-password');
  const db = sdk.firestore.initializeFirestore(app, settings);
  return { app, db };
}

describe('the real SDK against recorded production', () => {
  test('signing in returns the recorded account with a token shaped like Firebase Auth', async () => {
    const app = sdk.app.initializeApp(CONFIG, 'replay-sign-in');
    const credential = await sdk.auth.signInWithEmailAndPassword(sdk.auth.getAuth(app), 'reader@example.com', 'test-password');
    const token = await credential.user.getIdTokenResult();
    expect(credential.user.uid).toBe('user-reader');
    expect(credential.user.email).toBe('reader@example.com');
    expect(token.claims.aud).toBe('demo-replay');
    expect(token.signInProvider).toBe('password');
    expect(server.unmatched).toEqual([]);
  });

  test('a wrong password fails the way Auth answers it', async () => {
    const app = sdk.app.initializeApp(CONFIG, 'replay-wrong-password');
    const signIn = sdk.auth.signInWithEmailAndPassword(sdk.auth.getAuth(app), 'nobody@example.com', 'wrong');
    await expect(signIn).rejects.toMatchObject({ code: 'auth/invalid-credential' });
  });

  test('a read returns the recorded document', async () => {
    const { db } = await signedInApp();
    const snapshot = await sdk.firestore.getDoc(sdk.firestore.doc(db, 'rooms/lobby'));
    expect(snapshot.exists()).toBe(true);
    expect(snapshot.data()).toEqual({ name: 'Lobby', open: true, seats: 12 });
    expect(snapshot.metadata.fromCache).toBe(false);
    expect(server.unmatched).toEqual([]);
  });

  test('a denied read fails with permission-denied', async () => {
    const { db } = await signedInApp();
    const read = sdk.firestore.getDoc(sdk.firestore.doc(db, 'rooms/secret'));
    await expect(read).rejects.toMatchObject({ code: 'permission-denied', message: 'Missing or insufficient permissions.' });
    expect(server.unmatched).toEqual([]);
  });

  test('a query listener gets its first snapshot, then the document another client writes', async () => {
    const listener = await signedInApp();
    const writer = await signedInApp();
    const { collection, onSnapshot, query, where, setDoc, doc } = sdk.firestore;
    const snapshots: Array<{ ids: string[]; fromCache: boolean; hasPendingWrites: boolean }> = [];
    const stop = onSnapshot(query(collection(listener.db, 'rooms'), where('open', '==', true)), (snapshot) => {
      snapshots.push({ ids: snapshot.docs.map((room) => room.id), ...snapshot.metadata });
    });
    await waitFor(() => snapshots.length === 1);
    await setDoc(doc(writer.db, 'rooms/garden'), { name: 'Garden', open: true });
    await waitFor(() => snapshots.length === 2);
    stop();
    // The listener's client made no write, so its second snapshot can only come from the replayed Listen stream.
    expect(snapshots).toEqual([
      { ids: ['lobby'], fromCache: false, hasPendingWrites: false },
      { ids: ['garden', 'lobby'], fromCache: false, hasPendingWrites: false },
    ]);
    expect(server.unmatched).toEqual([]);
  });

  test('a write resolves once production acknowledges it', async () => {
    const { db } = await signedInApp();
    const write = sdk.firestore.setDoc(sdk.firestore.doc(db, 'rooms/garden'), { name: 'Garden', open: true });
    await expect(write).resolves.toBeUndefined();
    expect(server.unmatched).toEqual([]);
  });

  test('a denied write fails with permission-denied', async () => {
    const { db } = await signedInApp();
    const write = sdk.firestore.setDoc(sdk.firestore.doc(db, 'rooms/secret'), { name: 'Secret' });
    await expect(write).rejects.toMatchObject({ code: 'permission-denied' });
    expect(server.unmatched).toEqual([]);
  });

  test('long polling, which the SDK falls back to behind a buffering proxy, gets the same answers', async () => {
    const { db } = await signedInApp({ experimentalForceLongPolling: true });
    const snapshot = await sdk.firestore.getDoc(sdk.firestore.doc(db, 'rooms/lobby'));
    expect(snapshot.get('name')).toBe('Lobby');
  });
});

describe('the replay fails closed', () => {
  test('a read no recording holds fails and is listed', async () => {
    const { db } = await signedInApp();
    const read = sdk.firestore.getDoc(sdk.firestore.doc(db, 'rooms/unrecorded'));
    await expect(read).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('rooms/unrecorded') });
    expect(server.unmatched).toEqual([
      { rpc: 'Listen', as: 'user-reader', request: { documents: { documents: ['projects/demo-replay/databases/(default)/documents/rooms/unrecorded'] } } },
    ]);
  });

  test('a write no recording holds fails and is listed', async () => {
    const { db } = await signedInApp();
    const write = sdk.firestore.setDoc(sdk.firestore.doc(db, 'rooms/lobby'), { name: 'Renamed' });
    await expect(write).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(server.unmatched.map((entry) => entry.rpc)).toEqual(['Write']);
  });

  test('a recorded read made as another user is not answered', async () => {
    apps += 1;
    const app = sdk.app.initializeApp(CONFIG, `replay-${apps}`);
    const read = sdk.firestore.getDoc(sdk.firestore.doc(sdk.firestore.getFirestore(app), 'rooms/lobby'));
    await expect(read).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(server.unmatched).toMatchObject([{ rpc: 'Listen', as: null }]);
  });

  test('the seam refuses every host it does not replay', () => {
    expect(() => rewrite('https://www.googleapis.com/oauth2/v4/token')).toThrow('refused a request to www.googleapis.com');
    expect(rewrite('http://127.0.0.1:9/x')).toBe('http://127.0.0.1:9/x');
    expect(rewrite('https://firestore.googleapis.com/a?b=1')).toBe(`${server.origin}/firestore.googleapis.com/a?b=1`);
  });
});

describe('recorded files hold shapes and test-project values only', () => {
  const recording = (exchanges: unknown[]): Recording => ({ format: 'pyric-replay/1', project: 'demo-replay', source: 'test', exchanges } as Recording);
  const auth = (body: Record<string, unknown>) => ({ kind: 'auth', id: 'a', request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:lookup' }, response: { status: 200, body } });

  test('the hand-written fixture passes', () => {
    expect(() => readRecording(ROOMS)).not.toThrow();
  });

  test('a real ID token is refused', () => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from('{"sub":"someone"}').toString('base64url')}.c2lnbmF0dXJl`;
    expect(() => assertShapesOnly(recording([auth({ idToken: jwt })]))).toThrow('holds a JWT');
  });

  test('an API key is refused', () => {
    expect(() => assertShapesOnly(recording([auth({ key: `AIza${'x'.repeat(35)}` })]))).toThrow('holds a Google API key');
  });

  test('a document outside the test project is refused', () => {
    const listen = { kind: 'listen', id: 'l', target: { documents: { documents: ['projects/someone-else/databases/(default)/documents/a/b'] } }, batches: [] };
    expect(() => assertShapesOnly(recording([listen]))).toThrow('outside project demo-replay');
  });

  test('a read time that is not a placeholder is refused', () => {
    const listen = { kind: 'listen', id: 'l', target: {}, batches: [{ messages: [{ targetChange: { readTime: '2026-11-01T00:00:00Z' } }] }] };
    expect(() => assertShapesOnly(recording([listen]))).toThrow('readTime must be one of the placeholders');
  });

  test('a delete write whose result carries an updateTime is refused, as production leaves it unset', () => {
    const name = 'projects/demo-replay/databases/(default)/documents/rooms/attic';
    const commitTime = { $: 'commitTime' };
    const write = { kind: 'write', id: 'w', writes: [{ delete: name }], response: { writeResults: [{ updateTime: commitTime }], commitTime } };
    const commit = { kind: 'admin-firestore', id: 'c', rpc: 'Commit', request: { database: 'projects/demo-replay/databases/(default)', writes: [{ delete: name }] }, responses: [{ writeResults: [{ updateTime: commitTime }], commitTime }] };
    expect(() => assertShapesOnly(recording([write]))).toThrow('exchanges[0].response.writeResults[0] answers a delete');
    expect(() => assertShapesOnly(recording([commit]))).toThrow('exchanges[0].responses[0].writeResults[0] answers a delete');
    expect(() => assertShapesOnly(recording([{ ...write, response: { writeResults: [{}], commitTime } }]))).not.toThrow();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
