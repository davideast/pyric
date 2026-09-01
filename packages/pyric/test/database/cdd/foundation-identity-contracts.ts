import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  TARGET_SYMBOL,
  get,
  getDatabase,
  ref,
  sandbox as databaseSandbox,
  set,
} from '../../../src/database/index.js';

export async function assertFrozenIdentityRouting(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  expect(db[TARGET_SYMBOL].kind).toBe('sandbox');
  databaseSandbox.setRules(db, {
    rules: { users: { '$uid': { '.read': '$uid === auth.uid', '.write': '$uid === auth.uid' } } },
  });

  sandbox.currentUser = { uid: 'bob' };
  await set(ref(db, 'users/alice/value'), 1);
  expect((await get(ref(db, 'users/alice/value'))).val()).toBe(1);
  await expect(set(ref(db, 'users/bob/value'), 2)).rejects.toThrow('PERMISSION_DENIED');
}

export async function assertLiveIdentityRouting(): Promise<void> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox);
  expect(db[TARGET_SYMBOL].kind).toBe('sandbox-live');
  databaseSandbox.setRules(db, {
    rules: { users: { '$uid': { '.read': '$uid === auth.uid', '.write': '$uid === auth.uid' } } },
  });

  await expect(set(ref(db, 'users/alice/value'), 1)).rejects.toThrow('PERMISSION_DENIED');
  sandbox.currentUser = { uid: 'alice' };
  await set(ref(db, 'users/alice/value'), 1);
  sandbox.currentUser = { uid: 'bob' };
  await expect(get(ref(db, 'users/alice/value'))).rejects.toThrow('PERMISSION_DENIED');
  await set(ref(db, 'users/bob/value'), 2);
}

export async function assertDatabaseBackendIdentity(): Promise<void> {
  const firstSandbox = initializeSandbox();
  const secondSandbox = initializeSandbox();
  const first = getDatabase(firstSandbox);
  const sibling = getDatabase(firstSandbox);
  const isolated = getDatabase(secondSandbox);
  databaseSandbox.setDefaultPolicy(first, 'allow');
  databaseSandbox.setDefaultPolicy(isolated, 'allow');

  await set(ref(first, 'shared/value'), 1);
  expect((await get(ref(sibling, 'shared/value'))).val()).toBe(1);
  expect((await get(ref(isolated, 'shared/value'))).val()).toBeNull();
  await set(ref(isolated, 'shared/value'), 2);
  expect((await get(ref(first, 'shared/value'))).val()).toBe(1);
  expect((await get(ref(isolated, 'shared/value'))).val()).toBe(2);
}
