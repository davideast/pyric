/**
 * The live-firestore row names the document or collection path each call
 * touched, over the real `firebase/firestore` with no backend reachable:
 * Firestore points at a loopback port nothing listens on and has its network
 * disabled before any call, so reads answer from the memory cache or reject
 * offline. Each record still names its path and project, and none carries a
 * value.
 *
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/firestore-row.test.ts'`.
 */
import { createServer } from 'node:net';
import { afterAll, describe, expect, test } from 'bun:test';
import * as realApp from 'firebase/app';
import * as realFirestore from 'firebase/firestore';
import { observedCallOf } from '../src/page-observer.js';
import { liveModuleFor, type LiveCallRecord, type LiveModuleSite, type LiveObserver } from '../src/index.js';

/** A loopback port nothing listens on: the system hands one out, and the server is closed again. */
async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  return address.port;
}

const CLOSED_PORT = await closedLoopbackPort();
const PROJECT = 'demo-live-paths';
const VALUE = 'value-that-never-reaches-a-record';

const records: LiveCallRecord[] = [];
const observer: LiveObserver = (record) => {
  records.push(record);
};
const site: LiveModuleSite = { observer, sdkVersion: realApp.SDK_VERSION, client: 'node' };
const firestore = liveModuleFor('firebase/firestore', realFirestore, site);

const app = realApp.initializeApp({ apiKey: 'demo-api-key', projectId: PROJECT, appId: '1:1:web:live-paths' }, 'live-paths');
const db = firestore.getFirestore(app);
realFirestore.connectFirestoreEmulator(db, '127.0.0.1', CLOSED_PORT);
await realFirestore.disableNetwork(db);

afterAll(async () => {
  await realFirestore.terminate(db);
  await realApp.deleteApp(app);
});

/** The records of one export, settled. */
async function recordsOf(name: string, call: () => Promise<unknown>): Promise<LiveCallRecord[]> {
  records.length = 0;
  await call().catch(() => undefined);
  return records.filter((record) => record.name === name && record.outcome !== 'returned');
}

describe('a Firestore record names the path its call touched', () => {
  test('a document read names the document path and project', async () => {
    const found = await recordsOf('getDoc', () => firestore.getDoc(firestore.doc(db, 'rooms/a')));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ module: 'firebase/firestore', path: 'rooms/a', projectId: PROJECT });
  });

  test('a cache read of a collection names the collection path', async () => {
    const found = await recordsOf('getDocsFromCache', () => firestore.getDocsFromCache(firestore.collection(db, 'rooms')));
    expect(found).toEqual([expect.objectContaining({ outcome: 'resolved', path: 'rooms', projectId: PROJECT })]);
  });

  test('a simple query names its collection path', async () => {
    const query = firestore.query(firestore.collection(db, 'rooms/a/messages'), firestore.where('author', '==', VALUE), firestore.limit(5));
    const found = await recordsOf('getDocsFromCache', () => firestore.getDocsFromCache(query));
    expect(found[0]?.path).toBe('rooms/a/messages');
    expect(JSON.stringify(found)).not.toContain(VALUE);
  });

  test('a collection-group query names its group id', async () => {
    const found = await recordsOf('getDocsFromCache', () => firestore.getDocsFromCache(firestore.collectionGroup(db, 'messages')));
    expect(found[0]?.path).toBe('messages');
  });

  test('a listener names its path on every delivery', async () => {
    records.length = 0;
    const delivered = new Promise<void>((resolve) => {
      const unsubscribe = firestore.onSnapshot(firestore.doc(db, 'rooms/c'), () => {
        unsubscribe();
        resolve();
      });
    });
    await delivered;
    const deliveries = records.filter((record) => record.outcome === 'delivered');
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((record) => record.path === 'rooms/c')).toBe(true);
  });

  test('a call whose first argument is the Firestore names no path, only its project', async () => {
    const found = await recordsOf('runTransaction', () => firestore.runTransaction(db, async () => VALUE, { maxAttempts: 1 }));
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBeUndefined();
    expect(found[0]?.projectId).toBe(PROJECT);
  });

  test('the observed call the host gets carries the path', async () => {
    const found = await recordsOf('getDocsFromCache', () => firestore.getDocsFromCache(firestore.collection(db, 'rooms')));
    const call = observedCallOf(found[0]!, 1);
    expect(call).toMatchObject({ service: 'firestore', method: 'getDocsFromCache', path: 'rooms', projectId: PROJECT });
    expect(JSON.stringify(call)).not.toContain(VALUE);
  });
});
