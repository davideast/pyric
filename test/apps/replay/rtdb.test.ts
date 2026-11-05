/**
 * The real `@firebase/database` web SDK signs in, sets, gets and reads a
 * denied path against the replay server's RTDB WebSocket endpoint, answered
 * from recorded exchanges. Database is the browser build, so it connects with
 * the runtime's native WebSocket, as a page does. The app code below is plain
 * SDK code: it points Auth and Database at the replay server with
 * `connectAuthEmulator` and `connectDatabaseEmulator`, and passes no
 * `mockUserToken`, so the ID token Auth minted is the one the `auth` frame
 * carries.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/rtdb.test.ts'`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Database } from 'firebase/database';
import { assertShapesOnly, readRecording, type Recording } from './format.ts';
import { routeFirebaseTo } from './seam.ts';
import { startReplayServer, type ReplayServer } from './server.ts';

const MINIMAL = join(import.meta.dir, 'fixtures', 'rtdb-minimal.json');
const PROJECT = 'demo-replay-rtdb';
const CONFIG = {
  projectId: PROJECT,
  apiKey: 'test-api-key',
  appId: '1:1:web:replay',
  authDomain: `${PROJECT}.firebaseapp.com`,
  databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com`,
};
const TIMEOUT_MS = 5000;

type FirebaseApp = typeof import('firebase/app');
type FirebaseAuth = typeof import('firebase/auth');
type FirebaseDatabase = typeof import('firebase/database');

/** `@firebase/database`'s browser ESM build, found next to the Node build that `firebase/database` resolves to. */
function databaseBrowserEntry(): string {
  const firebaseDatabase = createRequire(import.meta.url).resolve('firebase/database');
  const nodeEntry = createRequire(firebaseDatabase).resolve('@firebase/database');
  return join(dirname(nodeEntry), 'index.esm.js');
}

let server: ReplayServer;
let stopRouting: () => void;
let port: number;
let firebase: FirebaseApp;
let auth: FirebaseAuth;
let database: FirebaseDatabase;
let apps = 0;

beforeAll(async () => {
  server = await startReplayServer([readRecording(MINIMAL)]);
  port = Number(new URL(server.origin).port);
  // The app reaches the server through the emulator connectors, so the seam
  // routes nothing here. It is installed before Auth loads because Auth takes
  // `fetch` once per process, and other replay test files share this one.
  stopRouting = routeFirebaseTo(server.origin);
  firebase = (await import('firebase/app')) as FirebaseApp;
  auth = (await import('firebase/auth')) as FirebaseAuth;
  database = (await import(pathToFileURL(databaseBrowserEntry()).href)) as FirebaseDatabase;
});

afterAll(async () => {
  for (const app of firebase.getApps()) await firebase.deleteApp(app);
  stopRouting();
  await server.close();
});

beforeEach(() => {
  server.unmatched.length = 0;
});

/** A fresh app pointed at the replay server, as the app under test sets itself up, signed in anonymously unless told not to. */
async function appDatabase(signIn = true): Promise<{ db: Database; uid: string | null }> {
  apps += 1;
  const app = firebase.initializeApp(CONFIG, `rtdb-replay-${apps}`);
  const appAuth = auth.getAuth(app);
  auth.connectAuthEmulator(appAuth, server.origin, { disableWarnings: true });
  const credential = signIn ? await auth.signInAnonymously(appAuth) : null;
  const db = database.getDatabase(app);
  database.connectDatabaseEmulator(db, '127.0.0.1', port);
  return { db, uid: credential?.user.uid ?? null };
}

describe('the real Database SDK against recorded production', () => {
  test('an anonymous user sets a value and gets it back', async () => {
    const { db, uid } = await appDatabase();
    const { ref, set, get } = database;
    expect(uid).toBe('user-anon');
    await set(ref(db, 'items/a'), { n: 1, s: 'alpha' });
    const snapshot = await get(ref(db, 'items/a'));
    expect(snapshot.val()).toEqual({ n: 1, s: 'alpha' });
    // The set and get exchanges are recorded for `user-anon` only, so they are
    // answered only once the `auth` frame carried the token Auth minted for it.
    expect(server.unmatched).toEqual([]);
  }, TIMEOUT_MS);

  test('a denied read fails with the recorded permission_denied', async () => {
    const { db } = await appDatabase();
    const read = database.get(database.ref(db, 'secret'));
    await expect(read).rejects.toThrow('Permission denied');
    expect(server.unmatched).toEqual([]);
  }, TIMEOUT_MS);
});

describe('the RTDB replay fails closed', () => {
  test('a read no recording holds fails with pyric_replay_no_recording and is listed', async () => {
    const { db } = await appDatabase();
    const read = database.get(database.ref(db, 'unrecorded'));
    await expect(read).rejects.toThrow('pyric_replay_no_recording');
    expect(server.unmatched).toEqual([
      { rpc: 'rtdb', as: 'user-anon', request: { instance: `${PROJECT}-default-rtdb`, a: 'g', b: { p: '/unrecorded', q: {} } } },
    ]);
  }, TIMEOUT_MS);

  test('a recorded write made without signing in is not answered', async () => {
    const { db } = await appDatabase(false);
    const write = database.set(database.ref(db, 'items/a'), { n: 1, s: 'alpha' });
    await expect(write).rejects.toThrow('PYRIC_REPLAY_NO_RECORDING');
    expect(server.unmatched).toMatchObject([{ rpc: 'rtdb', as: null, request: { a: 'p' } }]);
  }, TIMEOUT_MS);
});

describe('recorded RTDB exchanges hold test-project values only', () => {
  const recording = (exchanges: unknown[]): Recording => ({ format: 'pyric-replay/1', project: PROJECT, source: 'test', exchanges } as Recording);

  test('the hand-written fixture passes', () => {
    expect(() => readRecording(MINIMAL)).not.toThrow();
  });

  test('an instance outside the test project is refused', () => {
    const exchange = { kind: 'rtdb', id: 'r', instance: 'someone-else-default-rtdb', request: { a: 'g', b: { p: '/a', q: {} } }, reply: { s: 'ok', d: null } };
    expect(() => assertShapesOnly(recording([exchange]))).toThrow(`outside project ${PROJECT}`);
  });

  test('a handshake host that is not a placeholder is refused', () => {
    const handshake = { t: 'c', d: { t: 'h', d: { ts: { $: 'serverTime' }, v: '5', h: 's-gke-usc1-nssi2-16.firebaseio.com', s: { $: 'session' } } } };
    const exchange = { kind: 'rtdb', id: 'connect', instance: `${PROJECT}-default-rtdb`, events: [handshake] };
    expect(() => assertShapesOnly(recording([exchange]))).toThrow('must be one of the placeholders {"$":"host"}');
  });
});
