import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createIndexedDBBackend, createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore as getSandboxFirestore } from 'pyric/firestore';
import { isFirestoreDatabaseDeclared, setRules as setSandboxRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import type { InitPayload } from '../../../src/serve/namespace.js';
import {
  WORKER_PROTOCOL_VERSION,
  adminGetDocument,
  adminReadState,
  adminSetDocument,
  collection,
  count,
  disableNetwork,
  doc,
  enableNetwork,
  endAt,
  endBefore,
  getCountFromServer,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  requestDatabaseId,
  resetAll,
  runTransaction,
  setDoc,
  setRules,
  startAfter,
  startAt,
  terminate,
  wirePort,
  withDatabaseId,
  writeBatch,
  type ClientDb,
  type ClientPort,
} from '../../../src/serve/worker/index.js';
import { handleMessage, type HostCtx } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { buildWorkerCtx } from '../../../src/serve/worker/worker-boot.js';

const OPEN_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if true; }',
  '  }',
  '}',
].join('\n');

const LOCKED_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if false; }',
  '  }',
  '}',
].join('\n');

function createLoopbackClient(
  ctx: HostCtx,
  options: { protocolVersion?: 1 | 2; intercept?: (msg: InboundMessage) => void } = {},
): ClientDb {
  const protocolVersion = options.protocolVersion ?? 2;
  const port: ClientPort = {
    onmessage: null,
    start() {},
    close() {},
    postMessage(msg: InboundMessage) {
      options.intercept?.(msg);
      if (msg.t === 'op' && msg.method === 'getRuntimeEpoch') {
        let value: { version: string; workerProtocol?: number };
        if (protocolVersion === 1) {
          value = { version: 'legacy-1' };
        } else {
          value = { version: 'v2-test', workerProtocol: WORKER_PROTOCOL_VERSION };
        }
        const reply: OutboundMessage = { t: 'res', id: msg.id, ok: true, value };
        queueMicrotask(() => port.onmessage?.({ data: reply } as MessageEvent<OutboundMessage>));
        return;
      }
      const hostPort = {
        postMessage(out: OutboundMessage) {
          queueMicrotask(() => port.onmessage?.({ data: out } as MessageEvent<OutboundMessage>));
        },
      };
      void handleMessage(ctx, hostPort, msg);
    },
  };
  wirePort(port);
  return { __kind: 'client-db', type: 'firestore', port };
}

function makeHostCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return {
    db: getSandboxFirestore(sandbox),
    sandbox,
    instanceId: 'worker-named-db-test',
    subs: new Map(),
    appOptions: { projectId: 'worker-proj' },
  };
}

describe('Worker protocol v2 databaseId routing, validation, and protocol-1 refusal (#1318)', () => {
  it('routes reads, writes, batches, transactions, listeners, rules, and admin ops per database while keeping (default) frames unchanged', async () => {
    const ctx = makeHostCtx();
    const sentFrames: InboundMessage[] = [];
    const defaultDb = createLoopbackClient(ctx, { intercept: (f) => sentFrames.push(f) });
    const reportsDb = withDatabaseId(defaultDb, 'reports');

    expect(WORKER_PROTOCOL_VERSION).toBe(2);
    expect(withDatabaseId(defaultDb, '(default)')).toBe(defaultDb);

    await setRules(defaultDb, OPEN_RULES);
    await setRules(reportsDb, OPEN_RULES);

    // `(default)` frames omit `databaseId` on the wire.
    await setDoc(doc(defaultDb, 'items/shared'), { source: 'default', n: 1 });
    const defaultSetFrame = sentFrames.find(
      (f) => f.t === 'op' && f.method === 'setDoc' && !('databaseId' in f),
    );
    expect(defaultSetFrame).toBeDefined();
    expect(requestDatabaseId(defaultSetFrame)).toBeUndefined();

    // Named-database frames carry `databaseId: 'reports'`.
    await setDoc(doc(reportsDb, 'items/shared'), { source: 'reports', n: 10 });
    const reportsSetFrame = sentFrames.find(
      (f) => f.t === 'op' && f.method === 'setDoc' && f.databaseId === 'reports',
    );
    expect(reportsSetFrame).toBeDefined();
    expect(requestDatabaseId(reportsSetFrame)).toBe('reports');

    expect((await getDoc(doc(defaultDb, 'items/shared'))).data()).toEqual({ source: 'default', n: 1 });
    expect((await getDoc(doc(reportsDb, 'items/shared'))).data()).toEqual({ source: 'reports', n: 10 });

    // Batch + count + query isolation on `reports`.
    const batch = writeBatch(reportsDb);
    batch.set(doc(reportsDb, 'items/two'), { source: 'reports-batch', n: 20 });
    await batch.commit();
    expect((await getCountFromServer(collection(defaultDb, 'items'))).data().count).toBe(1);
    expect((await getCountFromServer(collection(reportsDb, 'items'))).data().count).toBe(2);
    expect((await getDocs(collection(reportsDb, 'items'))).size).toBe(2);

    // Transaction read-set validation on `reports` (must read `reports` live doc, never `(default)`!).
    await runTransaction(reportsDb, async (tx) => {
      const snap = await tx.get(doc(reportsDb, 'items/shared'));
      const prev = (snap.data()?.n as number | undefined) ?? 0;
      tx.update(doc(reportsDb, 'items/shared'), { n: prev + 5 });
    });
    expect((await getDoc(doc(reportsDb, 'items/shared'))).data()).toEqual({ source: 'reports', n: 15 });
    expect((await getDoc(doc(defaultDb, 'items/shared'))).data()).toEqual({ source: 'default', n: 1 });

    // Listener isolation across databases.
    const seenReports: unknown[] = [];
    const unsub = onSnapshot(doc(reportsDb, 'items/shared'), (snap) => {
      seenReports.push(snap.data());
    });
    await new Promise((r) => setTimeout(r, 20));
    const beforeDefaultWrite = seenReports.length;
    await setDoc(doc(defaultDb, 'items/shared'), { source: 'default-updated', n: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(seenReports.length).toBe(beforeDefaultWrite);

    await setDoc(doc(reportsDb, 'items/shared'), { source: 'reports-updated', n: 99 });
    await new Promise((r) => setTimeout(r, 20));
    expect(seenReports.at(-1)).toEqual({ source: 'reports-updated', n: 99 });
    unsub();

    // Per-database security rules: locking `reports` denies `reports` while `(default)` stays open.
    await setRules(reportsDb, LOCKED_RULES);
    await expect(getDoc(doc(reportsDb, 'items/shared'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect((await getDoc(doc(defaultDb, 'items/shared'))).data()).toEqual({
      source: 'default-updated',
      n: 2,
    });

    // Admin ops bypass rules on `reports` and answer C3 not-found on undeclared databases.
    expect(await adminGetDocument(reportsDb, 'items/shared')).toEqual({
      source: 'reports-updated',
      n: 99,
    });
    await adminSetDocument(reportsDb, 'items/admin-doc', { by: 'admin' });
    expect(Object.keys(await adminReadState(reportsDb)).sort()).toEqual([
      'items/admin-doc',
      'items/shared',
      'items/two',
    ]);

    const missingDb = withDatabaseId(defaultDb, 'undeclared-db');
    await expect(adminGetDocument(missingDb, 'items/any')).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('The database undeclared-db does not exist for project worker-proj'),
    });
  });

  it('refuses malformed wire databaseId frames in inbound-validation', async () => {
    const ctx = makeHostCtx();
    const replies: OutboundMessage[] = [];
    const port = { postMessage: (m: OutboundMessage) => replies.push(m) };

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'bad-empty',
      method: 'getDoc',
      path: 'items/one',
      databaseId: '',
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'bad-long',
      method: 'getDoc',
      path: 'items/one',
      databaseId: 'x'.repeat(257),
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'bad-non-fs',
      method: 'auth.listUsers',
      databaseId: 'reports',
    } as unknown as InboundMessage);

    expect(replies.length).toBe(3);
    for (const r of replies) {
      expect(r).toMatchObject({ t: 'res', ok: false, error: { code: 'invalid-argument' } });
    }
  });

  it('refuses sending named-database frames to a protocol-1 peer while allowing (default) frames', async () => {
    const ctx = makeHostCtx();
    await setRules(createLoopbackClient(ctx), OPEN_RULES);
    const sentToLegacy: InboundMessage[] = [];
    const legacyDefault = createLoopbackClient(ctx, {
      protocolVersion: 1,
      intercept: (msg) => sentToLegacy.push(msg),
    });
    const legacyReports = withDatabaseId(legacyDefault, 'reports');

    await setDoc(doc(legacyDefault, 'items/ok'), { v: 1 });
    expect((await getDoc(doc(legacyDefault, 'items/ok'))).data()).toEqual({ v: 1 });

    await expect(getDoc(doc(legacyReports, 'items/ok'))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('@pyric/cli 0.1.0-alpha.35 or later'),
    });
    // Verify the named-database getDoc was blocked client-side and never reached the protocol-1 peer!
    expect(
      sentToLegacy.some((m) => m.t === 'op' && m.method === 'getDoc' && m.databaseId === 'reports'),
    ).toBe(false);

    // Protocol-1 onSnapshot reports failed-precondition via onError...
    const snapError = await new Promise<Error & { code?: string }>((resolve, reject) => {
      const unsub = onSnapshot(
        doc(legacyReports, 'items/ok'),
        () => reject(new Error('Expected protocol-1 onSnapshot to fail')),
        (err) => {
          unsub();
          resolve(err as Error & { code?: string });
        },
      );
    });
    expect(snapError.code).toBe('failed-precondition');
    expect(snapError.message).toContain('@pyric/cli 0.1.0-alpha.35 or later');

    // ...and immediate unsub() suppresses async protocol-1 error delivery.
    let cancelledErrorFired = false;
    const cancelImmediately = onSnapshot(
      doc(legacyReports, 'items/cancelled'),
      () => {},
      () => {
        cancelledErrorFired = true;
      },
    );
    cancelImmediately();
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelledErrorFired).toBe(false);
  });

  it('delivers C3 cached-empty onSnapshot, keeps setDoc pending, and allocates zero host entries for undeclared databases', async () => {
    const ctx = makeHostCtx();
    const defaultDb = createLoopbackClient(ctx);
    const missingDb = withDatabaseId(defaultDb, 'undeclared-db');

    await expect(getDoc(doc(missingDb, 'items/one'))).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Failed to get document because the client is offline.',
    });

    const initialSnap = await new Promise<{ fromCache: boolean; exists: boolean }>((resolve, reject) => {
      const unsub = onSnapshot(
        doc(missingDb, 'items/one'),
        (snap) => {
          unsub();
          resolve({ fromCache: snap.metadata.fromCache, exists: snap.exists() });
        },
        reject,
      );
    });
    expect(initialSnap).toEqual({ fromCache: true, exists: false });

    let writeSettled = false;
    const pending = setDoc(doc(missingDb, 'items/one'), { a: 1 }).then(
      () => { writeSettled = true; },
      () => { writeSettled = true; },
    );
    await new Promise((r) => setTimeout(r, 25));
    expect(writeSettled).toBe(false);
    expect(ctx.firestoreDatabases?.has('undeclared-db') ?? false).toBe(false);

    await terminate(missingDb);
    void pending;
  });

  it('isolates client offline write queue and cache projection per database across disableNetwork and enableNetwork', async () => {
    const ctx = makeHostCtx();
    const defaultDb = createLoopbackClient(ctx);
    const reportsDb = withDatabaseId(defaultDb, 'reports');
    await setRules(defaultDb, OPEN_RULES);
    await setRules(reportsDb, OPEN_RULES);

    await setDoc(doc(defaultDb, 'items/x'), { v: 1 });
    expect((await getDoc(doc(defaultDb, 'items/x'))).data()).toEqual({ v: 1 });

    await disableNetwork(defaultDb);
    const offlineReportsWrite = setDoc(doc(reportsDb, 'items/x'), { v: 2 });

    // Staged `reports` write must NOT leak into `(default)` offline reads, and vice versa.
    expect((await getDoc(doc(defaultDb, 'items/x'))).data()).toEqual({ v: 1 });
    expect((await getDoc(doc(reportsDb, 'items/x'))).data()).toEqual({ v: 2 });

    await enableNetwork(defaultDb);
    await offlineReportsWrite;

    expect((await getDoc(doc(defaultDb, 'items/x'))).data()).toEqual({ v: 1 });
    expect((await getDoc(doc(reportsDb, 'items/x'))).data()).toEqual({ v: 2 });
  });
});

describe('SharedWorker buildWorkerCtx multi-database IndexedDB and --persist durability (#1318)', () => {
  it('persists named databases under <base>/firestore/<id>, mirrors firestoreDatabases, survives reset + reload, and clears leftovers', async () => {
    const key = `pyric-sw-test-${Math.random().toString(36).slice(2)}`;
    const idb = createIndexedDBBackend();
    let mirroredFirestoreBody: string | null = null;

    const payload: InitPayload = {
      activityToken: 'tok',
      projectKey: 'proj-sw',
      persist: true,
      rules: OPEN_RULES,
      rulesHash: null,
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
    };

    const makeFetch = (): typeof fetch =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u === '/__pyric/init.json') {
          return new Response(JSON.stringify(payload), { status: 200 });
        }
        if (u.includes('/__pyric/state?section=firestore')) {
          if ((init?.method ?? 'GET') === 'POST') {
            mirroredFirestoreBody = String(init?.body ?? '');
            return new Response('', { status: 204 });
          }
          if (mirroredFirestoreBody !== null && mirroredFirestoreBody !== 'null') {
            return new Response(mirroredFirestoreBody, { status: 200 });
          }
          return new Response('null', { status: 404 });
        }
        return new Response('', { status: 204 });
      }) as typeof fetch;

    // Boot 1: write to `(default)` and `reports`, flush, verify IDB keys and `--persist` bundle!
    const ctx1 = await buildWorkerCtx({ fetch: makeFetch(), idb, persistenceKey: key });
    const client1 = createLoopbackClient(ctx1);
    const reports1 = withDatabaseId(client1, 'reports');
    await setRules(reports1, OPEN_RULES);
    await setDoc(doc(client1, 'docs/one'), { plane: 'default' });
    await setDoc(doc(reports1, 'docs/one'), { plane: 'reports' });
    await ctx1.sandbox.flush();

    expect((await idb.listRecords(key)).includes('meta')).toBe(true);
    expect((await idb.listRecords(`${key}/firestore/reports`)).includes('meta')).toBe(false);
    expect((await idb.listRecords(`${key}/firestore/reports`)).length).toBeGreaterThan(0);
    expect(mirroredFirestoreBody).not.toBeNull();
    const parsedMirror = JSON.parse(mirroredFirestoreBody!) as {
      format: string;
      records: Record<string, unknown>;
      firestoreDatabases?: Record<string, unknown>;
    };
    expect(parsedMirror.format).toBe('pyric-v3-records');
    expect(parsedMirror.firestoreDatabases?.reports).toBeDefined();
    ctx1.sandbox.dispose();

    // Boot 2: reload SharedWorker against warm IDB -> verify isolation, then resetAll + reload!
    const ctx2 = await buildWorkerCtx({ fetch: makeFetch(), idb, persistenceKey: key });
    expect(isFirestoreDatabaseDeclared(ctx2.sandbox, 'reports')).toBe(true);
    expect(snapshotDocuments(ctx2.sandbox)).toEqual({ 'docs/one': { plane: 'default' } });
    expect(snapshotDocuments(ctx2.sandbox, 'reports')).toEqual({ 'docs/one': { plane: 'reports' } });

    const client2 = createLoopbackClient(ctx2);
    await resetAll(client2);
    await ctx2.sandbox.flush();
    ctx2.sandbox.dispose();

    // Boot 3: reload after resetAll -> both come back empty while `reports` stays declared!
    const ctx3 = await buildWorkerCtx({ fetch: makeFetch(), idb, persistenceKey: key });
    expect(isFirestoreDatabaseDeclared(ctx3.sandbox, 'reports')).toBe(true);
    expect(snapshotDocuments(ctx3.sandbox)).toEqual({});
    expect(snapshotDocuments(ctx3.sandbox, 'reports')).toEqual({});

    // Seed an undeclared leftover IDB database `<key>/firestore/leftover` and verify clearPersistence wipes it!
    await idb.putRecords(`${key}/firestore/leftover`, new Map([['00', { docs: {} }]]));
    expect((await idb.listRecords(`${key}/firestore/leftover`)).length).toBe(1);
    await ctx3.sandbox.clearPersistence();
    expect(await idb.listRecords(key)).toEqual([]);
    expect(await idb.listRecords(`${key}/firestore/reports`)).toEqual([]);
    expect(await idb.listRecords(`${key}/firestore/leftover`)).toEqual([]);
    expect(mirroredFirestoreBody).toBe('null');
    ctx3.sandbox.dispose();

    // Also verify priming from `--persist` server bundle into a fresh empty backend!
    mirroredFirestoreBody = JSON.stringify(parsedMirror);
    const freshMemory = createMemoryBackend();
    const ctx4 = await buildWorkerCtx({ fetch: makeFetch(), idb: freshMemory, persistenceKey: `${key}-fresh` });
    expect(isFirestoreDatabaseDeclared(ctx4.sandbox, 'reports')).toBe(true);
    expect(snapshotDocuments(ctx4.sandbox)).toEqual({ 'docs/one': { plane: 'default' } });
    expect(snapshotDocuments(ctx4.sandbox, 'reports')).toEqual({ 'docs/one': { plane: 'reports' } });
    ctx4.sandbox.dispose();
  });

  it('supports snapshot cursors on named databases and preserves listener send order across initial protocol negotiation (#3286)', async () => {
    const ctx = makeHostCtx();
    setSandboxRules(ctx.sandbox, OPEN_RULES);
    setSandboxRules(ctx.sandbox, OPEN_RULES, 'reports');
    const sentFrames: InboundMessage[] = [];
    const defaultDb = createLoopbackClient(ctx, { intercept: (f) => sentFrames.push(f) });
    const reportsDb = withDatabaseId(defaultDb, 'reports');

    // First operation on this port is a named-database listener immediately
    // followed by a default-database read; `sub` must reach the host ahead of
    // `getDoc` despite async protocol negotiation.
    const watched: boolean[] = [];
    const unsub = onSnapshot(doc(reportsDb, 'items/watched'), (snap) => {
      watched.push(snap.exists());
    });
    await getDoc(doc(defaultDb, 'items/barrier'));
    unsub();

    expect(watched).toEqual([false]);
    const subIdx = sentFrames.findIndex((f) => f.t === 'sub' && f.databaseId === 'reports');
    const barrierIdx = sentFrames.findIndex(
      (f) => f.t === 'op' && f.method === 'getDoc' && f.path === 'items/barrier',
    );
    expect(subIdx).toBeGreaterThanOrEqual(0);
    expect(barrierIdx).toBeGreaterThan(subIdx);

    // Snapshot cursors (`startAt`, `startAfter`, `endAt`, `endBefore`) on a named database.
    await setDoc(doc(reportsDb, 'items/a'), { rank: 1 });
    await setDoc(doc(reportsDb, 'items/b'), { rank: 2 });
    await setDoc(doc(reportsDb, 'items/c'), { rank: 3 });

    const snapA = await getDoc(doc(reportsDb, 'items/a'));
    const snapC = await getDoc(doc(reportsDb, 'items/c'));

    const afterA = await getDocs(
      query(collection(reportsDb, 'items'), orderBy('rank', 'asc'), startAfter(snapA), endBefore(snapC)),
    );
    expect(afterA.docs.map((d) => d.id)).toEqual(['b']);

    const inclusive = await getDocs(
      query(collection(reportsDb, 'items'), orderBy('rank', 'asc'), startAt(snapA), endAt(snapC)),
    );
    expect(inclusive.docs.map((d) => d.id)).toEqual(['a', 'b', 'c']);

    ctx.sandbox.dispose();
  });
});
