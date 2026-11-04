/**
 * The recorder makes a recorded-exchange file from a real run. Here the run's
 * "production" is a replay server, so the test stays offline: the real SDK
 * talks to the recorder, the recorder forwards to the replay server, and the
 * file it returns must hold shapes only and answer the same calls when
 * replayed on its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ListenExchange, Recording, WriteExchange } from './format.ts';
import { startRecorder } from './recorder.ts';
import { routeFirebaseTo } from './seam.ts';
import { loadSdk, type Sdk } from './sdk.ts';
import { readRecording } from './format.ts';
import { startReplayServer, type ReplayServer } from './server.ts';

const ROOMS = join(import.meta.dir, 'fixtures', 'rooms.json');
const CONFIG = { projectId: 'demo-replay', apiKey: 'test-api-key', appId: '1:1:web:recorder', authDomain: 'demo-replay.firebaseapp.com' };

let sdk: Sdk;
let apps = 0;
let upstream: ReplayServer;
let recorded: Recording;

/** The app code a scenario would run: sign in, read, a denied read, a listener and a write from a second client. */
async function run(): Promise<{ lobby: unknown; denied: string; rooms: string[][] }> {
  const { app, auth, firestore } = sdk;
  const open = async () => {
    apps += 1;
    const instance = app.initializeApp(CONFIG, `recorder-${apps}`);
    await auth.signInWithEmailAndPassword(auth.getAuth(instance), 'reader@example.com', 'test-password');
    return firestore.getFirestore(instance);
  };
  const db = await open();
  const lobby = (await firestore.getDoc(firestore.doc(db, 'rooms/lobby'))).data();
  const denied = await firestore.getDoc(firestore.doc(db, 'rooms/secret')).then(() => 'allowed', (error: { code: string }) => error.code);
  const rooms: string[][] = [];
  const stop = firestore.onSnapshot(firestore.query(firestore.collection(db, 'rooms'), firestore.where('open', '==', true)), (snapshot) => {
    rooms.push(snapshot.docs.map((room) => room.id));
  });
  await waitFor(() => rooms.length === 1);
  const writer = await open();
  await firestore.setDoc(firestore.doc(writer, 'rooms/garden'), { name: 'Garden', open: true });
  await waitFor(() => rooms.length === 2);
  stop();
  return { lobby, denied, rooms };
}

beforeAll(async () => {
  upstream = await startReplayServer([readRecording(ROOMS)]);
  const recorder = await startRecorder({ project: 'demo-replay', source: 'recorder test', upstream: (host) => `${upstream.origin}/${host}` });
  const stopRouting = routeFirebaseTo(recorder.origin);
  sdk = await loadSdk();
  await run();
  for (const app of sdk.app.getApps()) await sdk.app.deleteApp(app);
  recorded = await recorder.stop();
  stopRouting();
  await upstream.close();
});

afterAll(async () => {
  for (const app of sdk.app.getApps()) await sdk.app.deleteApp(app);
});

describe('a recording made by the recorder', () => {
  test('holds the calls the run made', () => {
    const kinds = recorded.exchanges.map((exchange) => exchange.kind === 'auth' ? `auth ${exchange.request.path}` : exchange.kind);
    expect(kinds).toContain('auth /v1/accounts:signInWithPassword');
    expect(kinds).toContain('auth /v1/accounts:lookup');
    expect(kinds.filter((kind) => kind === 'listen')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'write')).toHaveLength(1);
  });

  test('keeps no token, password or server time', () => {
    const text = JSON.stringify(recorded);
    expect(text).not.toContain('test-password');
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain(Buffer.from('replay-').toString('base64').slice(0, 8));
    expect(text).not.toContain('"readTime":"');
  });

  test('ties the listener batch the write released to that write', () => {
    const write = recorded.exchanges.find((exchange): exchange is WriteExchange => exchange.kind === 'write')!;
    const listener = recorded.exchanges.find((exchange): exchange is ListenExchange => exchange.kind === 'listen' && 'query' in exchange.target)!;
    expect(listener.batches.map((batch) => batch.after)).toEqual([undefined, write.id]);
    expect(JSON.stringify(listener.batches[1])).toContain('{"$":"commitTime"}');
  });

  test('answers the same run when replayed on its own', async () => {
    const replay = await startReplayServer([recorded]);
    const stopRouting = routeFirebaseTo(replay.origin);
    try {
      const outcome = await run();
      expect(outcome).toEqual({ lobby: { name: 'Lobby', open: true, seats: 12 }, denied: 'permission-denied', rooms: [['lobby'], ['garden', 'lobby']] });
      expect(replay.unmatched).toEqual([]);
    } finally {
      stopRouting();
      await replay.close();
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
