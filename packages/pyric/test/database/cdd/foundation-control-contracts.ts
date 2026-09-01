import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FirebaseError } from '../../../src/app/index.js';
import {
  get,
  getDatabase,
  onValue,
  ref,
  remove,
  sandbox as databaseSandbox,
  set,
} from '../../../src/database/index.js';

type DeniedOperation = 'read' | 'write' | 'remove';

export async function assertDeniedErrorEnvelope(operation: DeniedOperation): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  databaseSandbox.setRules(db, { rules: { '.read': false, '.write': false } });
  const target = ref(db, 'denied');
  let caught: unknown;
  try {
    if (operation === 'read') await get(target);
    else if (operation === 'remove') await remove(target);
    else await set(target, 1);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(FirebaseError);
  const error = caught as Error & { code?: string };
  expect({
    code: error.code,
    message: error.message,
    errorName: error.name,
    constructorName: error.constructor.name,
    isErrorInstance: error instanceof Error,
  }).toEqual({
    code: 'PERMISSION_DENIED',
    message: 'PERMISSION_DENIED: Permission denied',
    errorName: 'Error',
    constructorName: 'Error',
    isErrorInstance: true,
  });
}

export function assertMissingValueListener(): void {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  databaseSandbox.setDefaultPolicy(db, 'allow');
  const events: Array<{ value: unknown; exists: boolean }> = [];
  const unsubscribe = onValue(ref(db, 'missing'), snapshot => events.push({
    value: snapshot.val(),
    exists: snapshot.exists(),
  }));
  expect(events).toEqual([{ value: null, exists: false }]);
  unsubscribe();
}

export async function assertSetDataBypassesRules(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  databaseSandbox.setRules(db, { rules: { '.read': true, '.write': false } });
  await expect(set(ref(db, 'blocked'), 1)).rejects.toThrow('PERMISSION_DENIED');
  databaseSandbox.setData(db, { '/seeded': { nested: true } });
  expect(databaseSandbox.snapshotState(db)).toEqual({ seeded: { nested: true } });
  expect((await get(ref(db, 'seeded'))).val()).toEqual({ nested: true });
}
