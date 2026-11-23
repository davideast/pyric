import { afterEach, describe, expect, it } from 'bun:test';
import {
  deleteApp as deleteUpstreamApp,
  getApps as getUpstreamApps,
  initializeApp as initializeUpstreamApp,
} from 'firebase-admin/app';
import { getFirestore as getUpstreamFirestore } from 'firebase-admin/firestore';
import { copyAdminReferenceRegistration } from 'pyric/sandbox/admin-compat';
import { deleteApp, getApps } from '../../src/app/index.js';
import {
  getFirestore,
  GrpcStatus,
  Timestamp,
  WriteResult,
  type BulkWriter,
  type BulkWriterError,
  type BulkWriterOptions,
} from '../../src/firestore/index.js';
import { inProcessFirestoreArm, sharedWorkerFirestoreArm } from './arms.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  await Promise.all(
    getUpstreamApps().map((app) => deleteUpstreamApp(app).catch(() => undefined)),
  );
});

function captureSyncThrow(fn: () => unknown): { name: string; message: string } | null {
  try {
    const value = fn();
    if (value !== null && typeof value === 'object' && 'catch' in value) {
      const promiseLike = value as Promise<unknown>;
      void promiseLike.catch(() => undefined);
    }
    return null;
  } catch (error) {
    if (error instanceof Error) {
      return { name: error.constructor.name, message: error.message };
    }
    return { name: 'NonError', message: String(error) };
  }
}

async function captureAsyncRejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe.each([
  ['in-process', inProcessFirestoreArm],
  ['shared-worker remote', sharedWorkerFirestoreArm],
] as const)('pyric-admin/firestore bulkWriter (%s)', (_label, makeArm) => {
  it('executes create, set, update, delete, onWriteResult, flush, idempotent close, and synchronous post-close throws matching upstream', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);
    await db.doc('bw/remove').set({ stale: true });

    const bw = db.bulkWriter({ throttling: false });
    const seenPaths: string[] = [];
    bw.onWriteResult((ref, result) => {
      expect(result).toBeInstanceOf(WriteResult);
      expect(result.writeTime).toBeInstanceOf(Timestamp);
      seenPaths.push(ref.path);
    });

    const p1 = bw.create(db.doc('bw/created'), { step: 1 });
    const p2 = bw.set(db.doc('bw/upserted'), { step: 2, keep: 'yes' });
    await bw.flush();
    await Promise.all([p1, p2]);

    const p3 = bw.update(db.doc('bw/created'), 'step', 3);
    const p4 = bw.set(db.doc('bw/upserted'), { extra: true }, { merge: true });
    const p5 = bw.delete(db.doc('bw/remove'), { exists: true });
    await bw.flush();
    await Promise.all([p3, p4, p5]);

    const closeFirst = bw.close();
    const closeSecond = bw.close();
    expect(closeFirst).toBe(closeSecond);
    await closeFirst;

    expect(seenPaths.length).toBe(5);
    expect((await db.doc('bw/created').get()).data()).toEqual({ step: 3 });
    expect((await db.doc('bw/upserted').get()).data()).toEqual({
      step: 2,
      keep: 'yes',
      extra: true,
    });
    expect((await db.doc('bw/remove').get()).exists).toBe(false);

    const upstreamApp = initializeUpstreamApp(
      { projectId: 'demo-upstream-bw' },
      'upstream-bw-close',
    );
    const upstreamDb = getUpstreamFirestore(upstreamApp);
    const upstreamBw = upstreamDb.bulkWriter();
    const upstreamCloseFirst = upstreamBw.close();
    const upstreamCloseSecond = upstreamBw.close();
    expect(upstreamCloseFirst).toBe(upstreamCloseSecond);
    await upstreamCloseFirst;

    const pyricPostCloseCalls: Array<[string, () => unknown]> = [
      ['flush', () => bw.flush()],
      ['create', () => bw.create(db.doc('bw/closed'), { x: 1 })],
      ['set', () => bw.set(db.doc('bw/closed'), { x: 1 })],
      ['update', () => bw.update(db.doc('bw/closed'), { x: 1 })],
      ['delete', () => bw.delete(db.doc('bw/closed'))],
      ['onWriteResult', () => bw.onWriteResult(() => undefined)],
      ['onWriteError', () => bw.onWriteError(() => false)],
    ];
    const upstreamPostCloseCalls: Array<[string, () => unknown]> = [
      ['flush', () => upstreamBw.flush()],
      ['create', () => upstreamBw.create(upstreamDb.doc('bw/closed'), { x: 1 })],
      ['set', () => upstreamBw.set(upstreamDb.doc('bw/closed'), { x: 1 })],
      ['update', () => upstreamBw.update(upstreamDb.doc('bw/closed'), { x: 1 })],
      ['delete', () => upstreamBw.delete(upstreamDb.doc('bw/closed'))],
      ['onWriteResult', () => upstreamBw.onWriteResult(() => undefined)],
      ['onWriteError', () => upstreamBw.onWriteError(() => false)],
    ];

    for (let i = 0; i < pyricPostCloseCalls.length; i += 1) {
      const pyricEntry = pyricPostCloseCalls[i];
      const upstreamEntry = upstreamPostCloseCalls[i];
      if (pyricEntry !== undefined && upstreamEntry !== undefined) {
        expect(captureSyncThrow(pyricEntry[1])).toEqual(
          captureSyncThrow(upstreamEntry[1]),
        );
      }
    }
  });

  it('validates bulkWriter(options) and synchronous write arguments identically to upstream', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);
    const upstreamApp = initializeUpstreamApp(
      { projectId: 'demo-upstream-opts' },
      'upstream-bw-opts',
    );
    const upstreamDb = getUpstreamFirestore(upstreamApp);

    const invalidOptions: unknown[] = [
      null,
      123,
      'invalid',
      [],
      new Date(),
      { throttling: null },
      { throttling: { initialOpsPerSecond: 0 } },
      { throttling: { initialOpsPerSecond: -3 } },
      { throttling: { initialOpsPerSecond: 1.5 } },
      { throttling: { initialOpsPerSecond: Number.NaN } },
      { throttling: { initialOpsPerSecond: Number.POSITIVE_INFINITY } },
      { throttling: { maxOpsPerSecond: 0 } },
      { throttling: { maxOpsPerSecond: '5' } },
      { throttling: { initialOpsPerSecond: 10, maxOpsPerSecond: 5 } },
    ];

    for (const candidate of invalidOptions) {
      const pyricThrown = captureSyncThrow(() =>
        db.bulkWriter(candidate as BulkWriterOptions),
      );
      const upstreamThrown = captureSyncThrow(() =>
        upstreamDb.bulkWriter(candidate as never),
      );
      expect(pyricThrown).not.toBeNull();
      expect(pyricThrown).toEqual(upstreamThrown);
    }

    const validOptions: Array<BulkWriterOptions | undefined> = [
      undefined,
      {},
      { throttling: true },
      { throttling: false },
      { throttling: {} },
      { throttling: { initialOpsPerSecond: 1 } },
      { throttling: { maxOpsPerSecond: 1 } },
      { throttling: { initialOpsPerSecond: 5, maxOpsPerSecond: 10 } },
      { throttling: { initialOpsPerSecond: 5, maxOpsPerSecond: 5 } },
    ];

    for (const candidate of validOptions) {
      const pyricBw = db.bulkWriter(candidate);
      const upstreamBw = upstreamDb.bulkWriter(candidate);
      await Promise.all([pyricBw.close(), upstreamBw.close()]);
    }

    const bw: BulkWriter = db.bulkWriter();
    const upstreamBw = upstreamDb.bulkWriter();

    expect(
      captureSyncThrow(() => bw.set('not-a-ref' as never, { ok: 1 })),
    ).toEqual(
      captureSyncThrow(() => upstreamBw.set('not-a-ref' as never, { ok: 1 })),
    );
    expect(
      captureSyncThrow(() => bw.set(db.doc('bw/bad-data'), { bad: undefined })),
    ).toEqual(
      captureSyncThrow(() =>
        upstreamBw.set(upstreamDb.doc('bw/bad-data'), { bad: undefined }),
      ),
    );
    expect(
      captureSyncThrow(() => bw.update(db.doc('bw/empty-update'), {})),
    ).toEqual(
      captureSyncThrow(() => upstreamBw.update(upstreamDb.doc('bw/empty-update'), {})),
    );

    await bw.close();
  });

  it('surfaces BulkWriterError instances to onWriteError and operation rejections, supports custom retries past 10 attempts, and resolves flush/close on failures', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);
    const dupRef = db.doc('bw/already-there');
    const missingRef = db.doc('bw/missing-target');
    await dupRef.set({ initial: true });

    // Without custom onWriteError, non-retryable errors reject with BulkWriterError after 1 attempt
    // while flush() and close() still resolve without rejecting.
    const defaultBw = db.bulkWriter();
    const dupPromise = defaultBw.create(dupRef, { next: true });
    dupPromise.catch(() => undefined);
    await expect(defaultBw.flush()).resolves.toBeUndefined();
    const dupErr = await captureAsyncRejection(() => dupPromise);
    await expect(defaultBw.close()).resolves.toBeUndefined();

    expect(dupErr).toBeInstanceOf(Error);
    if (dupErr instanceof Error) {
      const typedErr = dupErr as Error & {
        code?: unknown;
        documentRef?: unknown;
        operationType?: unknown;
        failedAttempts?: unknown;
      };
      expect(typedErr.constructor.name).toBe('BulkWriterError');
      expect(typedErr.code).toBe(GrpcStatus.ALREADY_EXISTS);
      expect(typedErr.documentRef).toBe(dupRef);
      expect(typedErr.operationType).toBe('create');
      expect(typedErr.failedAttempts).toBe(1);
    }

    // Custom onWriteError overwrites the 10-attempt default cap and can recover or stop on demand.
    const retryBw = db.bulkWriter();
    const attemptsSeen: number[] = [];
    retryBw.onWriteError((error: BulkWriterError) => {
      expect(error).toBeInstanceOf(Error);
      attemptsSeen.push(error.failedAttempts);
      if (error.documentRef.path === dupRef.path && error.failedAttempts === 2) {
        return false;
      }
      return error.failedAttempts < 12;
    });

    const dupFail2 = captureAsyncRejection(() => retryBw.create(dupRef, { retry: true }));
    const missingFail12 = captureAsyncRejection(() =>
      retryBw.update(missingRef, { retry: true }),
    );
    await retryBw.close();

    const resolvedDupFail = (await dupFail2) as { failedAttempts?: number; code?: number };
    const resolvedMissingFail = (await missingFail12) as {
      failedAttempts?: number;
      code?: number;
      operationType?: string;
    };
    expect(resolvedDupFail.code).toBe(GrpcStatus.ALREADY_EXISTS);
    expect(resolvedDupFail.failedAttempts).toBe(2);
    expect(resolvedMissingFail.code).toBe(GrpcStatus.NOT_FOUND);
    expect(resolvedMissingFail.operationType).toBe('update');
    expect(resolvedMissingFail.failedAttempts).toBe(12);
    expect(attemptsSeen.includes(12)).toBe(true);
  });

  it('does not re-run a committed write if onWriteResult throws, and propagates callback errors', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);
    const bw = db.bulkWriter();
    let errorCallbackCount = 0;
    bw.onWriteError(() => {
      errorCallbackCount += 1;
      return true;
    });
    bw.onWriteResult(() => {
      throw new Error('user onWriteResult boom');
    });

    const writeErr = await captureAsyncRejection(() =>
      bw.create(db.doc('bw/once-only'), { created: 1 }),
    );
    await bw.close();

    expect(errorCallbackCount).toBe(0);
    expect(writeErr).toBeInstanceOf(Error);
    if (writeErr instanceof Error) {
      expect(writeErr.message).toBe('user onWriteResult boom');
    }
    expect((await db.doc('bw/once-only').get()).data()).toEqual({ created: 1 });
  });

  it('retries default batchWrite transient gRPC codes up to 10 attempts when onWriteError is not set', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);

    const makeTransientRef = (
      path: string,
      statusCode: number,
      failTimes: number,
    ): ReturnType<typeof db.doc> => {
      const realRef = db.doc(path);
      let calls = 0;
      const proxiedRef = new Proxy(realRef, {
        get(target, prop, receiver) {
          if (prop === 'set' || prop === 'delete') {
            return (...args: unknown[]) => {
              calls += 1;
              if (calls <= failTimes) {
                const transient = Object.assign(new Error('transient rpc error'), {
                  code: statusCode,
                });
                return Promise.reject(transient);
              }
              const method = Reflect.get(target, prop, target) as (
                ...a: unknown[]
              ) => Promise<WriteResult>;
              return method.apply(target, args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      copyAdminReferenceRegistration(realRef, proxiedRef);
      return proxiedRef;
    };

    const bw = db.bulkWriter();
    // UNAVAILABLE (14) succeeds on attempt 3 under default retry policy.
    const recoveredRef = makeTransientRef(
      'bw/transient-ok',
      GrpcStatus.UNAVAILABLE as number,
      2,
    );
    const recoveredRes = await bw.set(recoveredRef, { ok: true });
    expect(recoveredRes).toBeInstanceOf(WriteResult);
    expect((await db.doc('bw/transient-ok').get()).data()).toEqual({ ok: true });

    // delete + INTERNAL (13) is retryable up to 10 attempts (fails at failedAttempts === 10).
    const exhaustedDeleteRef = makeTransientRef(
      'bw/transient-del',
      GrpcStatus.INTERNAL as number,
      25,
    );
    const delErr = (await captureAsyncRejection(() =>
      bw.delete(exhaustedDeleteRef),
    )) as { code?: number; failedAttempts?: number; operationType?: string };
    expect(delErr.code).toBe(GrpcStatus.INTERNAL);
    expect(delErr.operationType).toBe('delete');
    expect(delErr.failedAttempts).toBe(10);

    // set + INTERNAL (13) is NOT retryable by default (fails at failedAttempts === 1).
    const nonRetrySetRef = makeTransientRef(
      'bw/internal-set',
      GrpcStatus.INTERNAL as number,
      25,
    );
    const setErr = (await captureAsyncRejection(() =>
      bw.set(nonRetrySetRef, { ok: false }),
    )) as { code?: number; failedAttempts?: number; operationType?: string };
    expect(setErr.code).toBe(GrpcStatus.INTERNAL);
    expect(setErr.operationType).toBe('set');
    expect(setErr.failedAttempts).toBe(1);

    await bw.close();
  });
});
