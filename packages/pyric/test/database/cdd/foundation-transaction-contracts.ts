import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FirebaseError } from '../../../src/app/index.js';
import {
  get,
  getDatabase,
  onValue,
  ref,
  runTransaction,
  sandbox as databaseSandbox,
  set,
} from '../../../src/database/index.js';

export async function assertTransactionAbortContract(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const target = ref(db, 'counter');
  await set(target, 100);
  const events: unknown[] = [];
  const unsubscribe = onValue(target, snapshot => events.push(snapshot.val()));
  const result = await runTransaction(target, () => undefined);
  expect(result.committed).toBe(false);
  expect(result.snapshot.val()).toBe(100);
  expect((await get(target)).val()).toBe(100);
  expect(events).toEqual([100]);
  unsubscribe();
}

export async function assertApplyLocallyContract(): Promise<void> {
  for (const applyLocally of [true, false]) {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    const target = ref(db, 'counter');
    await set(target, 1);
    const events: unknown[] = [];
    const unsubscribe = onValue(target, snapshot => events.push(snapshot.val()));
    const result = await runTransaction(target, current => (current as number) + 10, { applyLocally });
    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toBe(11);
    expect((await get(target)).val()).toBe(11);
    expect(events).toEqual([1, 11]);
    unsubscribe();
  }
}

export async function assertDeniedTransactionEnvelope(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  databaseSandbox.setRules(db, { rules: { '.read': false, '.write': false } });
  let updateFnCallCount = 0;
  let caught: unknown;
  let resolved: unknown = null;
  try {
    resolved = await runTransaction(ref(db, 'denied'), () => {
      updateFnCallCount += 1;
      return 1;
    });
  } catch (error) {
    caught = error;
  }
  expect(resolved).toBeNull();
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(FirebaseError);
  const error = caught as Error & { code?: unknown };
  expect({
    code: error.code ?? null,
    hasCode: 'code' in error,
    message: error.message,
    errorName: error.name,
    constructorName: error.constructor.name,
    isErrorInstance: error instanceof Error,
    updateFnCallCount,
  }).toEqual({
    code: null,
    hasCode: false,
    message: 'permission_denied',
    errorName: 'Error',
    constructorName: 'Error',
    isErrorInstance: true,
    updateFnCallCount: 1,
  });
}

export async function assertTransactionContentionBoundary(): Promise<void> {
  const sandbox = initializeSandbox();
  const first = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  const second = getDatabase(sandbox.withAuth({ uid: 'bob' }));
  const target = ref(first, 'counter');
  await set(target, 0);
  const calls = [0, 0];
  const results = await Promise.all([
    runTransaction(target, current => { calls[0] += 1; return (current as number) + 1; }),
    runTransaction(ref(second, 'counter'), current => { calls[1] += 1; return (current as number) + 1; }),
  ]);
  expect(calls).toEqual([1, 1]);
  expect(calls).not.toEqual([2, 3]);
  expect(results.map(result => result.committed)).toEqual([true, true]);
  expect(results.map(result => result.snapshot.val()).sort()).toEqual([1, 2]);
  expect((await get(target)).val()).toBe(2);

  let injected = false;
  const seen: unknown[] = [];
  const retryTarget = ref(first, 'retry');
  await set(retryTarget, 0);
  const retried = await runTransaction(retryTarget, current => {
    seen.push(current);
    if (!injected) {
      injected = true;
      void set(ref(second, 'retry'), 10);
    }
    return (current as number) + 1;
  });
  expect(seen).toEqual([0, 10]);
  expect(retried.committed).toBe(true);
  expect(retried.snapshot.val()).toBe(11);
}
