import 'fake-indexeddb/auto';
import { describe, expect, it, jest } from 'bun:test';
import { createMemoryBackend, initializeSandbox, type PersistenceBackend } from 'pyric/sandbox';
import { getDatabaseAdmin, parseNamedFirestoreBundleRecords } from 'pyric/firestore/internal';
import {
  declareFirestoreDatabase,
  isFirestoreDatabaseDeclared,
  snapshotDocuments,
} from 'pyric/sandbox/firestore';
import type { InitPayload } from '../../../src/serve/namespace.js';
import { setupInPagePersistence } from '../../../src/serve/entries/in-page-persistence.js';
import { getAuth, sandbox as authOps } from 'pyric/auth';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { createWorkerDurableBackend } from '../../../src/serve/worker/durable-persistence.js';
import { createWorkerFirestorePersistenceBinding } from '../../../src/serve/worker/firestore-persistence-backend.js';
import { handleMessage } from '../../../src/serve/worker/host.js';
import { buildWorkerCtx } from '../../../src/serve/worker/worker-boot.js';

const OPEN_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if true; }',
  '  }',
  '}',
].join('\n');

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolveFn: (value: T | PromiseLike<T>) => void = () => {};
  let rejectFn: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

async function drainMicrotasks(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

function makePersistPayload(): InitPayload {
  return {
    activityToken: 'tok-clear',
    projectKey: 'proj-clear',
    persist: true,
    rules: OPEN_RULES,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: null,
    seed: null,
  };
}

describe('SharedWorker and Hosted clearPersistence races (#3294)', () => {
  it('CASE_A: clearPersistence() cancels armed named-DB, controller, and auth mirror timers so cleared state never resurrects', async () => {
    const key = 'case-a-worker';
    const idb = createMemoryBackend();
    let mirroredFirestoreBody: string | null = null;
    let mirroredAuthBody: string | null = null;
    const payload = makePersistPayload();

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
        if (u.includes('/__pyric/state?section=auth')) {
          if ((init?.method ?? 'GET') === 'POST') {
            mirroredAuthBody = String(init?.body ?? '');
            return new Response('', { status: 204 });
          }
          return new Response('null', { status: 404 });
        }
        return new Response('', { status: 204 });
      }) as typeof fetch;

    const ctx1 = await buildWorkerCtx({ fetch: makeFetch(), idb, persistenceKey: key });
    declareFirestoreDatabase(ctx1.sandbox, 'reports');
    await ctx1.sandbox.flush();
    ctx1.sandbox.dispose();

    jest.useFakeTimers();
    const ctx2 = await buildWorkerCtx({ fetch: makeFetch(), idb, persistenceKey: key });
    try {
      // Also arm the 400ms setupServerAuthFlush timer right before clearPersistence().
      await handleMessage(
        ctx2,
        { postMessage() {} },
        { t: 'op', id: 'u1', method: 'auth.createUser', email: 'a@example.com', password: 'password123' },
      );

      await ctx2.sandbox.clearPersistence();
      expect(await idb.listRecords(key)).toEqual([]);
      expect(mirroredFirestoreBody).toBe('null');

      // Advance past 50ms named-DB autoFlushTimer, 250ms controller pendingFlush, and 400ms auth flush timer.
      jest.advanceTimersByTime(600);
      await drainMicrotasks(20);

      expect(await idb.listRecords(key)).toEqual([]);
      expect(await idb.listRecords(`${key}/firestore/reports`)).toEqual([]);
      expect(mirroredFirestoreBody).toBe('null');
      expect(mirroredAuthBody).toBe('null');
    } finally {
      ctx2.sandbox.dispose();
      jest.useRealTimers();
    }
  });

  it('CASE_B: clearPersistence() orders after in-flight firestore and auth mirror POSTs so null is never overwritten', async () => {
    const key = 'case-b-worker';
    const idb = createMemoryBackend();
    let mirroredFirestoreBody: string | null = null;
    let mirroredAuthBody: string | null = null;
    const enteredBundlePost = createDeferred();
    const releaseBundlePost = createDeferred();
    const enteredAuthPost = createDeferred();
    const releaseAuthPost = createDeferred();
    let gateNextBundlePost = false;
    let gateNextAuthPost = false;
    const payload = makePersistPayload();

    const makeFetch = (): typeof fetch =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u === '/__pyric/init.json') {
          return new Response(JSON.stringify(payload), { status: 200 });
        }
        if (u.includes('/__pyric/state?section=firestore')) {
          if ((init?.method ?? 'GET') === 'POST') {
            const body = String(init?.body ?? '');
            if (gateNextBundlePost && body !== 'null') {
              gateNextBundlePost = false;
              enteredBundlePost.resolve();
              // Server is already past request entry: it finishes writing even if client aborts.
              await releaseBundlePost.promise;
            }
            mirroredFirestoreBody = body;
            return new Response('', { status: 204 });
          }
          if (mirroredFirestoreBody !== null && mirroredFirestoreBody !== 'null') {
            return new Response(mirroredFirestoreBody, { status: 200 });
          }
          return new Response('null', { status: 404 });
        }
        if (u.includes('/__pyric/state?section=auth')) {
          if ((init?.method ?? 'GET') === 'POST') {
            const body = String(init?.body ?? '');
            if (gateNextAuthPost && body !== 'null') {
              gateNextAuthPost = false;
              enteredAuthPost.resolve();
              // Server is already past request entry: it finishes writing even if client aborts.
              await releaseAuthPost.promise;
            }
            mirroredAuthBody = body;
            return new Response('', { status: 204 });
          }
          return new Response('null', { status: 404 });
        }
        return new Response('', { status: 204 });
      }) as typeof fetch;

    jest.useFakeTimers();
    const ctx = await buildWorkerCtx({ fetch: makeFetch(), idb, persistenceKey: key });
    try {
      declareFirestoreDatabase(ctx.sandbox, 'reports');
      getDatabaseAdmin(ctx.sandbox, 'reports').setDocument('docs/one', { v: 1 });
      await handleMessage(
        ctx,
        { postMessage() {} },
        { t: 'op', id: 'u-b', method: 'auth.createUser', email: 'b@example.com', password: 'password123' },
      );

      gateNextBundlePost = true;
      gateNextAuthPost = true;
      const inFlightFlush = ctx.sandbox.flush();
      jest.advanceTimersByTime(450);
      await Promise.all([enteredBundlePost.promise, enteredAuthPost.promise]);

      let clearSettledWhileFlushPending = false;
      const clearPromise = ctx.sandbox.clearPersistence().then(() => {
        clearSettledWhileFlushPending = true;
      });
      await drainMicrotasks(20);
      expect(clearSettledWhileFlushPending).toBe(false);

      // Releasing only firestore must still hold clearPersistence() until in-flight auth POST finishes.
      releaseBundlePost.resolve();
      await drainMicrotasks(20);
      expect(clearSettledWhileFlushPending).toBe(false);

      releaseAuthPost.resolve();
      await Promise.all([inFlightFlush, clearPromise]);
      await drainMicrotasks(20);

      expect(await idb.listRecords(key)).toEqual([]);
      expect(await idb.listRecords(`${key}/firestore/reports`)).toEqual([]);
      expect(mirroredFirestoreBody).toBe('null');
      expect(mirroredAuthBody).toBe('null');
    } finally {
      ctx.sandbox.dispose();
      jest.useRealTimers();
    }
  });

  it('bounds mirrorChain and authChain drain waits when uncooperative in-flight POSTs ignore AbortSignal and hang forever', async () => {
    const key = 'case-b-hung-mirror';
    const idb = createMemoryBackend();
    let mirroredFirestoreBody: string | null = null;
    let mirroredAuthBody: string | null = null;
    const enteredHungFirestore = createDeferred();
    const enteredHungAuth = createDeferred();
    let hangNextFirestorePost = false;
    let hangNextAuthPost = false;
    const payload = makePersistPayload();

    const releaseHung = createDeferred<Response>();
    const makeFetch = (): typeof fetch =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u === '/__pyric/init.json') {
          return new Response(JSON.stringify(payload), { status: 200 });
        }
        if (u.includes('/__pyric/state?section=firestore') && (init?.method ?? 'GET') === 'POST') {
          const body = String(init?.body ?? '');
          if (hangNextFirestorePost && body !== 'null') {
            hangNextFirestorePost = false;
            enteredHungFirestore.resolve();
            return releaseHung.promise;
          }
          mirroredFirestoreBody = body;
          return new Response('', { status: 204 });
        }
        if (u.includes('/__pyric/state?section=auth') && (init?.method ?? 'GET') === 'POST') {
          const body = String(init?.body ?? '');
          if (hangNextAuthPost && body !== 'null') {
            hangNextAuthPost = false;
            enteredHungAuth.resolve();
            return releaseHung.promise;
          }
          mirroredAuthBody = body;
          return new Response('', { status: 204 });
        }
        return new Response('null', { status: 404 });
      }) as typeof fetch;

    jest.useFakeTimers();
    const ctx = await buildWorkerCtx({ fetch: makeFetch(), idb, persistenceKey: key });
    try {
      declareFirestoreDatabase(ctx.sandbox, 'reports');
      getDatabaseAdmin(ctx.sandbox, 'reports').setDocument('docs/hung', { v: 1 });
      authOps.seedUsers(getAuth(ctx.sandbox), [{ uid: 'u-h', email: 'h@example.com' }]);
      hangNextFirestorePost = true;
      hangNextAuthPost = true;

      // Fire both the 50ms named-DB auto-flush mirror and the 400ms auth mirror so both hang in-flight.
      jest.advanceTimersByTime(450);
      await Promise.all([enteredHungFirestore.promise, enteredHungAuth.promise]);

      let clearDone = false;
      const clearPromise = ctx.sandbox.clearPersistence().then(() => {
        clearDone = true;
      });
      jest.advanceTimersByTime(1_500);
      await drainMicrotasks(30);
      expect(clearDone).toBe(false);

      // Drain controller.clear()'s 2,000ms bound, let microtasks enter durable.clear(), then drain its 2,000ms bound.
      jest.advanceTimersByTime(700);
      await drainMicrotasks(40);
      jest.advanceTimersByTime(2_100);
      await drainMicrotasks(40);
      await clearPromise;

      expect(clearDone).toBe(true);
      expect(await idb.listRecords(key)).toEqual([]);
      expect(await idb.listRecords(`${key}/firestore/reports`)).toEqual([]);
      expect(mirroredFirestoreBody).toBe('null');
      expect(mirroredAuthBody).toBe('null');
    } finally {
      releaseHung.resolve(new Response('', { status: 204 }));
      ctx.sandbox.dispose();
      jest.useRealTimers();
    }
  });

  it('suppresses boot-hydration false auto-flushes without dropping real named-DB writes or deletes made while hydrate() is running', async () => {
    const baseKey = 'hydrate-race';
    const rawMemory = createMemoryBackend();

    // Seed persisted named database `reports` via a clean initial binding.
    const seedSandbox = initializeSandbox();
    const seedDurable = createWorkerDurableBackend(rawMemory, makePersistPayload(), {
      fetch: (async () => new Response('', { status: 204 })) as unknown as typeof fetch,
    });
    const seedBinding = createWorkerFirestorePersistenceBinding(seedSandbox, seedDurable, baseKey);
    await seedSandbox.enablePersistence({ key: baseKey, injectedBackend: seedBinding.backend, flushIntervalMs: 10_000 });
    await seedBinding.hydrate();
    declareFirestoreDatabase(seedSandbox, 'reports');
    getDatabaseAdmin(seedSandbox, 'reports').setDocument('docs/persisted', { origin: 'disk' });
    getDatabaseAdmin(seedSandbox, 'reports').setDocument('docs/deleted-after-write', { origin: 'disk' });
    getDatabaseAdmin(seedSandbox, 'reports').setDocument('docs/deleted-direct', { origin: 'disk' });
    await seedSandbox.flush();
    seedSandbox.dispose();

    // 1) Clean hydration with zero concurrent changes must NOT arm the 50ms autoFlushTimer.
    let flushPosts = 0;
    const countingDurable = createWorkerDurableBackend(rawMemory, makePersistPayload(), {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('section=firestore') && (init?.method ?? 'GET') === 'POST') {
          flushPosts += 1;
        }
        return new Response('', { status: 204 });
      }) as typeof fetch,
    });
    jest.useFakeTimers();
    const cleanSandbox = initializeSandbox();
    try {
      const cleanBinding = createWorkerFirestorePersistenceBinding(cleanSandbox, countingDurable, baseKey);
      await cleanSandbox.enablePersistence({
        key: baseKey,
        injectedBackend: cleanBinding.backend,
        flushIntervalMs: 10_000,
      });
      await cleanBinding.hydrate();
      jest.advanceTimersByTime(300);
      await drainMicrotasks(15);
      expect(flushPosts).toBe(0);
    } finally {
      cleanSandbox.dispose();
      jest.useRealTimers();
    }

    // 2) Real writes AND deletions made WHILE async hydrate() is awaiting listRecords MUST NOT be dropped or resurrected!
    const enteredHydrateList = createDeferred();
    const releaseHydrateList = createDeferred();
    let gateHydrateList = false;
    const gatedMemory: PersistenceBackend = {
      getRecord: (k, id) => rawMemory.getRecord(k, id),
      async listRecords(k) {
        if (gateHydrateList && k === `${baseKey}/firestore/reports`) {
          gateHydrateList = false;
          enteredHydrateList.resolve();
          await releaseHydrateList.promise;
        }
        return rawMemory.listRecords(k);
      },
      putRecords: (k, records) => rawMemory.putRecords(k, records),
      deleteRecords: (k, ids) => rawMemory.deleteRecords(k, ids),
      clear: (k) => rawMemory.clear(k),
    };

    let latestMirror: string | null = null;
    const mirrorPosted = createDeferred();
    const raceDurable = createWorkerDurableBackend(gatedMemory, makePersistPayload(), {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('section=firestore') && (init?.method ?? 'GET') === 'POST') {
          latestMirror = String(init?.body ?? '');
          mirrorPosted.resolve();
        }
        return new Response('', { status: 204 });
      }) as typeof fetch,
    });

    jest.useFakeTimers();
    const raceSandbox = initializeSandbox();
    try {
      const raceBinding = createWorkerFirestorePersistenceBinding(raceSandbox, raceDurable, baseKey);
      await raceSandbox.enablePersistence({
        key: baseKey,
        injectedBackend: raceBinding.backend,
        flushIntervalMs: 10_000,
      });

      gateHydrateList = true;
      const hydratePromise = raceBinding.hydrate();
      await enteredHydrateList.promise;

      // Mutate + delete persisted docs in `reports` and declare + mutate `live-during` while hydrate() is mid-flight!
      declareFirestoreDatabase(raceSandbox, 'reports');
      const reportsAdmin = getDatabaseAdmin(raceSandbox, 'reports');
      reportsAdmin.setDocument('docs/live', { origin: 'concurrent' });
      reportsAdmin.setDocument('docs/deleted-after-write', { origin: 'temp' });
      reportsAdmin.deleteDocument('docs/deleted-after-write');
      reportsAdmin.deleteDocument('docs/deleted-direct');
      declareFirestoreDatabase(raceSandbox, 'live-during');
      getDatabaseAdmin(raceSandbox, 'live-during').setDocument('docs/extra', { origin: 'concurrent-extra' });

      releaseHydrateList.resolve();
      await hydratePromise;

      expect(isFirestoreDatabaseDeclared(raceSandbox, 'reports')).toBe(true);
      expect(isFirestoreDatabaseDeclared(raceSandbox, 'live-during')).toBe(true);
      expect(snapshotDocuments(raceSandbox, 'reports')).toEqual({
        'docs/persisted': { origin: 'disk' },
        'docs/live': { origin: 'concurrent' },
      });
      expect(snapshotDocuments(raceSandbox, 'live-during')).toEqual({
        'docs/extra': { origin: 'concurrent-extra' },
      });

      // Advance 60ms so the autoFlushTimer armed during hydration flushes concurrent writes AND deletions!
      jest.advanceTimersByTime(60);
      await mirrorPosted.promise;

      expect(latestMirror).not.toBeNull();
      const parsed = JSON.parse(String(latestMirror)) as {
        firestoreDatabases?: Record<string, Record<string, unknown>>;
      };
      const reportsBuckets = parsed.firestoreDatabases?.reports ?? {};
      const flushedReportsDocs = parseNamedFirestoreBundleRecords(Object.entries(reportsBuckets));
      expect(flushedReportsDocs).toEqual({
        'docs/persisted': { origin: 'disk' },
        'docs/live': { origin: 'concurrent' },
      });
      expect(parsed.firestoreDatabases?.['live-during']).toBeDefined();
    } finally {
      raceSandbox.dispose();
      jest.useRealTimers();
    }
  });

  it('cancels the in-page 500ms authFlushTimer and clears section=auth on clearPersistence()', async () => {
    const prevFetch = globalThis.fetch;
    let firestoreSection: string | null = null;
    let authSection: string | null = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('section=firestore')) {
        if (method === 'POST') {
          firestoreSection = String(init?.body ?? '');
          return new Response('', { status: 204 });
        }
        if (firestoreSection !== null && firestoreSection !== 'null') {
          return new Response(firestoreSection, { status: 200 });
        }
        return new Response('null', { status: 404 });
      }
      if (u.includes('section=auth') && method === 'POST') {
        authSection = String(init?.body ?? '');
        return new Response('', { status: 204 });
      }
      return new Response('', { status: 204 });
    }) as typeof fetch;

    jest.useFakeTimers();
    const sandbox = createSandboxRoot();
    try {
      await setupInPagePersistence(sandbox, makePersistPayload(), {
        persistEnabled: false,
        lastFlushAt: null,
        persistReadOnly: false,
      });
      // Claim writer role via a sandbox write, then arm the 500ms authFlushTimer.
      sandbox.admin.setDocument('docs/claim', { ok: true });
      await sandbox.flush();
      authOps.seedUsers(getAuth(sandbox), [{ uid: 'u1', email: 'u1@example.com' }]);

      await sandbox.clearPersistence();
      expect(firestoreSection).toBe('null');
      expect(authSection).toBe('null');

      jest.advanceTimersByTime(700);
      await drainMicrotasks(20);
      expect(firestoreSection).toBe('null');
      expect(authSection).toBe('null');
    } finally {
      sandbox.dispose();
      jest.useRealTimers();
      globalThis.fetch = prevFetch;
    }
  });
});
