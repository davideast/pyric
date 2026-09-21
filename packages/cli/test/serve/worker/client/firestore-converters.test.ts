/**
 * Converters across the worker client surface.
 *
 * Collection and query handles carry a converter, and every operation that
 * accepts one has to keep it: `doc()`, `query()`, `addDoc`, `getDocs`,
 * `onSnapshot`, the read aliases, transactions, and batches. Run against a
 * real host over a fake port pair so the wire form is exercised too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import 'fake-indexeddb/auto';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore as ipGetFirestore } from 'pyric/firestore';
import type { HostCtx } from '../../../../src/serve/worker/host.js';
import * as client from '../../../../src/serve/worker/client.js';
import { readQueryAs, readDocumentAs } from '../../../../src/serve/worker/client/firestore-reads.js';
import { refEqual } from '../../../../src/serve/worker/client/firestore-reference-equality.js';
import type { CollRefHandle, DocRefHandle, QueryHandle } from '../../../../src/serve/worker/client/handles.js';
import { connectClientToHost, sleep } from '../integration-support.js';

const PERMISSIVE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

interface ItemDb extends Record<string, unknown> {
  label: string;
}
interface Item {
  id: string;
  label: string;
  converted: boolean;
}

const itemConverter = {
  toFirestore: (item: Item): ItemDb => ({ label: item.label.toUpperCase() }),
  fromFirestore: (snapshot: { id: string; data(): ItemDb }): Item => ({
    id: snapshot.id,
    label: String(snapshot.data().label ?? ''),
    converted: true,
  }),
};

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  await sandbox.enablePersistence({
    key: `converters-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return {
    db: ipGetFirestore(sandbox),
    sandbox,
    instanceId: 'converter-test',
    subs: new Map(),
  } as HostCtx;
}

let sequence = 0;
async function connect(): Promise<ReturnType<typeof client.getFirestore>> {
  const ctx = await makeCtx();
  const { db } = connectClientToHost(ctx, `worker://converters-${++sequence}`);
  return db;
}

/** The client's exported factories are typed against the canonical module. */
type ClientCollection<T> = CollRefHandle<T>;
const collectionOf = client.collection as unknown as (
  parent: unknown,
  ...segments: string[]
) => ClientCollection<unknown>;
const collectionGroupOf = client.collectionGroup as unknown as (
  db: unknown,
  id: string,
) => QueryHandle<unknown>;

describe('worker client converters', () => {
  let restoreSharedWorker: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSharedWorker = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSharedWorker());

  it('exposes withConverter on collection, collectionGroup, and query handles', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items');
    expect(typeof items.withConverter).toBe('function');
    expect(typeof collectionGroupOf(db, 'items').withConverter).toBe('function');
    expect(typeof (client.query(items as never) as unknown as QueryHandle).withConverter).toBe('function');
  });

  it('doc(typedCollection, id) inherits the converter on writes and reads', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items').withConverter(itemConverter);
    const ref = client.doc(items as never, 'one') as unknown as DocRefHandle<Item>;
    expect(ref.converter).toBe(itemConverter as never);
    await client.setDoc(ref as never, { id: 'one', label: 'hello', converted: true } as never);
    const snapshot = await client.getDoc(ref as never) as unknown as { data(): Item | undefined };
    expect(snapshot.data()).toEqual({ id: 'one', label: 'HELLO', converted: true });
  });

  it('doc(typedCollection) mints an auto id and inherits the converter', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items').withConverter(itemConverter);
    const ref = client.doc(items as never) as unknown as DocRefHandle<Item>;
    expect(ref.id).toHaveLength(20);
    expect(ref.path).toBe(`items/${ref.id}`);
    expect(ref.converter).toBe(itemConverter as never);
    await client.setDoc(ref as never, { id: ref.id, label: 'minted', converted: true } as never);
    const snapshot = await client.getDoc(ref as never) as unknown as { data(): Item | undefined };
    expect(snapshot.data()?.label).toBe('MINTED');
  });

  it('query(typedCollection, ...) inherits the converter through getDocs', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items').withConverter(itemConverter);
    await client.setDoc(client.doc(items as never, 'one') as never, { id: 'one', label: 'hello', converted: true } as never);
    const typedQuery = client.query(items as never, client.where('label', '==', 'HELLO'));
    const snapshot = await client.getDocs(typedQuery as never);
    expect(snapshot.docs).toHaveLength(1);
    expect(snapshot.docs[0]!.data()).toEqual({ id: 'one', label: 'HELLO', converted: true } as never);
    expect(snapshot.docs[0]!.ref.converter).toBe(itemConverter as never);
  });

  it('query(...).withConverter converts the documents getDocs yields', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items');
    await client.setDoc(client.doc(items as never, 'one') as never, { label: 'HELLO' } as never);
    const typedQuery = (client.query(items as never) as unknown as QueryHandle).withConverter(itemConverter);
    const snapshot = await client.getDocs(typedQuery as never);
    expect(snapshot.docs[0]!.data()).toEqual({ id: 'one', label: 'HELLO', converted: true } as never);
  });

  it('collectionGroup(...).withConverter converts across collections', async () => {
    const db = await connect();
    await client.setDoc(client.doc(db, 'teams/t1/items/a') as never, { label: 'ONE' } as never);
    await client.setDoc(client.doc(db, 'users/u1/items/b') as never, { label: 'TWO' } as never);
    const group = collectionGroupOf(db, 'items').withConverter(itemConverter);
    const snapshot = await client.getDocs(group as never);
    expect(snapshot.docs).toHaveLength(2);
    for (const item of snapshot.docs) expect((item.data() as unknown as Item).converted).toBe(true);
  });

  it('addDoc runs toFirestore and returns a reference carrying the converter', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items').withConverter(itemConverter);
    const ref = await client.addDoc(items as never, { id: 'x', label: 'added', converted: true } as never) as unknown as DocRefHandle<Item>;
    expect(ref.converter).toBe(itemConverter as never);
    const snapshot = await client.getDoc(ref as never) as unknown as { data(): Item | undefined };
    expect(snapshot.data()?.label).toBe('ADDED');
  });

  it('onSnapshot delivers converted data for a typed document and a typed query', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items').withConverter(itemConverter);
    const ref = client.doc(items as never, 'one') as unknown as DocRefHandle<Item>;
    await client.setDoc(ref as never, { id: 'one', label: 'hello', converted: true } as never);

    const documentDeliveries: unknown[] = [];
    const stopDocument = client.onSnapshot(ref as never, (snapshot: never) => {
      documentDeliveries.push((snapshot as { data(): unknown }).data());
    });
    const queryDeliveries: unknown[] = [];
    const stopQuery = client.onSnapshot(items as never, (snapshot: never) => {
      queryDeliveries.push(...(snapshot as { docs: Array<{ data(): unknown }> }).docs.map((d) => d.data()));
    });
    await sleep();
    stopDocument();
    stopQuery();

    expect(documentDeliveries[0]).toEqual({ id: 'one', label: 'HELLO', converted: true });
    expect(queryDeliveries[0]).toEqual({ id: 'one', label: 'HELLO', converted: true });
  });

  it('withConverter(null) removes the converter from a collection and a query', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items').withConverter(itemConverter);
    await client.setDoc(client.doc(items as never, 'one') as never, { id: 'one', label: 'hello', converted: true } as never);

    const untypedCollection = items.withConverter(null);
    expect(untypedCollection.converter).toBeNull();
    const rawDocument = await client.getDoc(client.doc(untypedCollection as never, 'one') as never);
    expect(rawDocument.data()).toEqual({ label: 'HELLO' } as never);

    const untypedQuery = (client.query(items as never) as unknown as QueryHandle).withConverter(null);
    const snapshot = await client.getDocs(untypedQuery as never);
    expect(snapshot.docs[0]!.data()).toEqual({ label: 'HELLO' } as never);
  });

  it('setDoc with merge runs toFirestore and updateDoc bypasses the converter', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items').withConverter(itemConverter);
    const ref = client.doc(items as never, 'one') as unknown as DocRefHandle<Item>;
    await client.setDoc(ref as never, { id: 'one', label: 'hello', converted: true } as never);
    await client.setDoc(ref as never, { id: 'one', label: 'merged', converted: true } as never, { merge: true } as never);
    await client.updateDoc(ref as never, { extra: 7 } as never);
    const raw = await client.getDoc(client.doc(db, 'items/one') as never);
    expect(raw.data()).toEqual({ label: 'MERGED', extra: 7 } as never);
  });

  it('the read aliases keep the converter on a typed source', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items').withConverter(itemConverter);
    const ref = client.doc(items as never, 'one') as unknown as DocRefHandle<Item>;
    await client.setDoc(ref as never, { id: 'one', label: 'hello', converted: true } as never);
    const fromServer = await readQueryAs(items as never, 'getDocsFromServer');
    expect((fromServer.docs[0]!.data() as unknown as Item).converted).toBe(true);
    const fromCache = await readDocumentAs(ref as never, 'getDocFromCache');
    expect((fromCache.data() as unknown as Item).label).toBe('HELLO');
  });

  it('getCountFromServer counts a typed collection', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items').withConverter(itemConverter);
    await client.setDoc(client.doc(items as never, 'one') as never, { id: 'one', label: 'a', converted: true } as never);
    const result = await client.getCountFromServer(items as never);
    expect(result.data().count).toBe(1);
  });

  it('transactions and batches keep the converter on a typed reference', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items').withConverter(itemConverter);
    const ref = client.doc(items as never, 'one') as unknown as DocRefHandle<Item>;
    await client.runTransaction(db as never, async (txn: never) => {
      (txn as unknown as { set(r: unknown, d: unknown): void }).set(ref, { id: 'one', label: 'txn', converted: true });
    });
    let snapshot = await client.getDoc(ref as never) as unknown as { data(): Item | undefined };
    expect(snapshot.data()?.label).toBe('TXN');

    const batch = client.writeBatch(db as never) as unknown as { set(r: unknown, d: unknown): unknown; commit(): Promise<void> };
    batch.set(ref, { id: 'one', label: 'batch', converted: true });
    await batch.commit();
    snapshot = await client.getDoc(ref as never) as unknown as { data(): Item | undefined };
    expect(snapshot.data()?.label).toBe('BATCH');
  });

  it('refEqual separates converted references from plain ones', async () => {
    const db = await connect();
    const items = collectionOf(db, 'items');
    const typed = items.withConverter(itemConverter);
    expect(refEqual(items as never, collectionOf(db, 'items') as never)).toBe(true);
    expect(refEqual(items as never, typed as never)).toBe(false);
    expect(refEqual(
      client.doc(typed as never, 'one') as never,
      client.doc(typed as never, 'one') as never,
    )).toBe(true);
    expect(refEqual(
      client.doc(typed as never, 'one') as never,
      client.doc(items as never, 'one') as never,
    )).toBe(false);
  });
});
