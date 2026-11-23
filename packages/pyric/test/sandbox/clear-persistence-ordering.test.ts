/**
 * Deterministic ordering and resilience tests for `Sandbox.clearPersistence()`
 * against concurrent, failing, and hung flushes (`#3294`).
 */
import { describe, expect, it, jest } from 'bun:test';
import {
  createMemoryBackend,
  deserializeFromBuckets,
  initializeSandbox,
  type PersistenceBackend,
} from '../../src/sandbox/index.js';

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

async function drainMicrotasks(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

async function readStoredFirestore(
  backend: PersistenceBackend,
  key: string,
): Promise<Record<string, Record<string, unknown>>> {
  const entries: Array<[string, unknown]> = [];
  for (const id of await backend.listRecords(key)) {
    entries.push([id, await backend.getRecord(key, id)]);
  }
  return deserializeFromBuckets(entries).firestore;
}

describe('Sandbox.clearPersistence flush-chain ordering (#3294)', () => {
  it('waits for an in-flight flush before clearing so stale flush writes never overwrite clear()', async () => {
    const inner = createMemoryBackend();
    const key = 'order-inflight';
    const enteredPut = createDeferred();
    const releasePut = createDeferred();
    let gateNextPut = false;

    const backend: PersistenceBackend = {
      getRecord: (k, id) => inner.getRecord(k, id),
      listRecords: (k) => inner.listRecords(k),
      async putRecords(k, records) {
        if (gateNextPut) {
          gateNextPut = false;
          enteredPut.resolve();
          await releasePut.promise;
        }
        await inner.putRecords(k, records);
      },
      deleteRecords: (k, ids) => inner.deleteRecords(k, ids),
      clear: (k) => inner.clear(k),
    };

    const sandbox = initializeSandbox();
    try {
      await sandbox.enablePersistence({ key, injectedBackend: backend, flushIntervalMs: 10_000 });
      sandbox.admin.setDocument('items/one', { v: 1 });

      gateNextPut = true;
      const flushPromise = sandbox.flush();
      await enteredPut.promise;

      const clearPromise = sandbox.clearPersistence();
      releasePut.resolve();
      await Promise.all([flushPromise, clearPromise]);

      expect(await inner.listRecords(key)).toEqual([]);
    } finally {
      sandbox.dispose();
    }
  });

  it('does not swallow an in-flight failing flush error and still clears the backend afterward', async () => {
    const inner = createMemoryBackend();
    const key = 'order-failing-flush';
    const enteredPut = createDeferred();
    const failPut = createDeferred();
    let gateFail = false;

    const backend: PersistenceBackend = {
      getRecord: (k, id) => inner.getRecord(k, id),
      listRecords: (k) => inner.listRecords(k),
      async putRecords(k, records) {
        if (gateFail) {
          gateFail = false;
          enteredPut.resolve();
          await failPut.promise;
        }
        await inner.putRecords(k, records);
      },
      deleteRecords: (k, ids) => inner.deleteRecords(k, ids),
      clear: (k) => inner.clear(k),
    };

    const sandbox = initializeSandbox();
    try {
      await sandbox.enablePersistence({ key, injectedBackend: backend, flushIntervalMs: 10_000 });
      sandbox.admin.setDocument('items/seed', { v: 1 });
      await sandbox.flush();
      expect((await inner.listRecords(key)).length).toBeGreaterThan(0);

      sandbox.admin.setDocument('items/two', { v: 2 });
      gateFail = true;
      const failingFlush = sandbox.flush();
      await enteredPut.promise;

      const clearPromise = sandbox.clearPersistence();
      failPut.reject(new Error('disk full during flush'));

      await expect(failingFlush).rejects.toThrow('disk full during flush');
      await clearPromise;
      expect(await inner.listRecords(key)).toEqual([]);
    } finally {
      sandbox.dispose();
    }
  });

  it('bounds waiting on a hung flush so clearPersistence() cannot hang forever and still surfaces the hung flush error', async () => {
    const inner = createMemoryBackend();
    const key = 'order-hung-flush';
    const enteredHung = createDeferred();
    const hungGate = createDeferred();
    let hangNextPut = false;

    const backend: PersistenceBackend = {
      getRecord: (k, id) => inner.getRecord(k, id),
      listRecords: (k) => inner.listRecords(k),
      async putRecords(k, records) {
        if (hangNextPut) {
          hangNextPut = false;
          enteredHung.resolve();
          await hungGate.promise;
        }
        await inner.putRecords(k, records);
      },
      deleteRecords: (k, ids) => inner.deleteRecords(k, ids),
      clear: (k) => inner.clear(k),
    };

    jest.useFakeTimers();
    const sandbox = initializeSandbox();
    try {
      await sandbox.enablePersistence({ key, injectedBackend: backend, flushIntervalMs: 10_000 });
      sandbox.admin.setDocument('items/seed', { v: 1 });
      await sandbox.flush();

      sandbox.admin.setDocument('items/hung', { v: 2 });
      hangNextPut = true;
      const hungFlush = sandbox.flush();
      // Attach rejection handler upfront so fake-timer stepping never triggers an unhandled warning.
      const hungRejection = hungFlush.then(
        () => null,
        (err: unknown) => err,
      );
      await enteredHung.promise;

      let clearSettled = false;
      const clearPromise = sandbox.clearPersistence().then(() => {
        clearSettled = true;
      });
      await drainMicrotasks();
      expect(clearSettled).toBe(false);

      jest.advanceTimersByTime(2_500);
      await clearPromise;
      expect(clearSettled).toBe(true);
      expect(await inner.listRecords(key)).toEqual([]);

      // When the hung backend call finally fails later, its caller still gets the error
      // and subsequent writes + flushes are not blocked by the detached hung flushChain.
      hungGate.reject(new Error('hung transport closed'));
      const caught = await hungRejection;
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('hung transport closed');

      sandbox.admin.setDocument('items/after-hung', { v: 3 });
      await sandbox.flush();
      expect(await readStoredFirestore(inner, key)).toEqual({
        'items/seed': { v: 1 },
        'items/hung': { v: 2 },
        'items/after-hung': { v: 3 },
      });
    } finally {
      sandbox.dispose();
      jest.useRealTimers();
    }
  });

  it('persists writes made after clearPersistence() resolves and resolves writes racing clear() into one linearizable state', async () => {
    const inner = createMemoryBackend();
    const key = 'order-racing-writes';
    const enteredClear = createDeferred();
    const releaseClear = createDeferred();
    let gateClear = false;

    const backend: PersistenceBackend = {
      getRecord: (k, id) => inner.getRecord(k, id),
      listRecords: (k) => inner.listRecords(k),
      putRecords: (k, records) => inner.putRecords(k, records),
      deleteRecords: (k, ids) => inner.deleteRecords(k, ids),
      async clear(k) {
        if (gateClear) {
          gateClear = false;
          enteredClear.resolve();
          await releaseClear.promise;
        }
        await inner.clear(k);
      },
    };

    const sandbox = initializeSandbox();
    try {
      await sandbox.enablePersistence({ key, injectedBackend: backend, flushIntervalMs: 10_000 });

      // Defined state 1: write + flush initiated BEFORE clearPersistence() ends cleared ([]).
      sandbox.admin.setDocument('items/before', { v: 1 });
      const flushBefore = sandbox.flush();
      const clearAfter = sandbox.clearPersistence();
      await Promise.all([flushBefore, clearAfter]);
      expect(await inner.listRecords(key)).toEqual([]);

      // Defined state 2: write + flush initiated WHILE clearPersistence() is in flight
      // executes strictly after clear() resets baselines, persisting full post-clear state.
      gateClear = true;
      const inFlightClear = sandbox.clearPersistence();
      await enteredClear.promise;

      sandbox.admin.setDocument('items/during-clear', { v: 2 });
      const flushDuringClear = sandbox.flush();
      releaseClear.resolve();
      await Promise.all([inFlightClear, flushDuringClear]);

      expect(await readStoredFirestore(inner, key)).toEqual({
        'items/before': { v: 1 },
        'items/during-clear': { v: 2 },
      });

      // Write made AFTER clearPersistence() resolves persists full state.
      await sandbox.clearPersistence();
      expect(await inner.listRecords(key)).toEqual([]);
      sandbox.admin.setDocument('items/after-clear', { v: 3 });
      await sandbox.flush();
      expect(await readStoredFirestore(inner, key)).toEqual({
        'items/before': { v: 1 },
        'items/during-clear': { v: 2 },
        'items/after-clear': { v: 3 },
      });
    } finally {
      sandbox.dispose();
    }
  });
});
