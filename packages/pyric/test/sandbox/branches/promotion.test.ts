/**
 * Tests for `promoteFullState`.
 *
 * The contract under test: a promotion writes the divergences the diff
 * reports, and nothing else. Each case gives a branch exactly one divergence,
 * in one service, and asserts that the target's other services and the state
 * the branch never touched come through untouched. The last case gives a
 * branch no divergence at all and asserts the promotion reaches no setter.
 */
import { describe, it, expect } from 'bun:test';

import { getAuth } from '../../../src/auth/instances.js';
import { targetOf } from '../../../src/auth/target.js';
import { getOrCreateBackend } from '../../../src/database/sandbox/backend-for.js';
import { initializeSandbox, type LocalSandbox } from '../../../src/sandbox/index.js';
import {
  applyFullState,
  captureFullState,
  type FullSandboxState,
} from '../../../src/sandbox/full-state.js';
import { getInternalEnv } from '../../../src/sandbox/internal/sandbox-impl.js';
import { fork } from '../../../src/sandbox/branches/engine.js';
import { promoteFullState } from '../../../src/sandbox/branches/promotion.js';
import { diffFullStates } from '../../../src/sandbox/branches/state-diff.js';
import { getAdminStorageSandbox } from '../../../src/storage/internal.js';
import { getBytes, ref as storageRef, uploadBytes } from '../../../src/storage/index.js';
import { sandbox as authDriver } from '../../../src/auth/sandbox/driver.js';
import { CANDIDATE_FIRESTORE_RULES, populatedSandbox } from './fixtures.js';

let nextTargetStorage = 1;

/**
 * A target holding the same state the branch forked from, plus one document
 * the branch never touched. The extra document is what proves the promotion
 * wrote a delta rather than replacing the target.
 */
async function targetOn(base: FullSandboxState): Promise<LocalSandbox> {
  const target = initializeSandbox();
  getAdminStorageSandbox(target, { dbName: `pyric-promotion-target:${nextTargetStorage++}` });
  await applyFullState(target, base);
  target.admin.setDocument('things/target-only', { v: 'target' });
  return target;
}

/** The branch that state, mutated by `change`, and the state it then holds. */
async function branchFrom(
  base: FullSandboxState,
  change: (sandbox: LocalSandbox) => void | Promise<void>,
): Promise<FullSandboxState> {
  const branch = await fork(base);
  await change(branch.sandbox);
  return captureFullState(branch.sandbox);
}

describe('promoteFullState lands the divergences the diff reports', () => {
  it('lands a Firestore document and leaves every other service alone', async () => {
    const source = await populatedSandbox();
    const base = await captureFullState(source);
    const next = await branchFrom(base, (sandbox) => {
      sandbox.admin.setDocument('things/a', { v: 2 });
    });
    expect(diffFullStates(base, next).map((d) => d.service)).toEqual(['firestore']);

    const target = await targetOn(base);
    await promoteFullState(target, base, next);

    const landed = await captureFullState(target);
    expect(landed.firestore['things/a']).toEqual({ v: 2 });
    expect(landed.firestore['things/keep']).toEqual({ v: 100 });
    expect(landed.firestore['things/target-only']).toEqual({ v: 'target' });
    expect(landed.database).toEqual(base.database);
    expect(landed.auth).toEqual(base.auth);
    expect(landed.storage).toEqual(base.storage);
    expect(landed.rules).toEqual(base.rules);
  });

  it('deletes a Firestore document the branch removed', async () => {
    const source = await populatedSandbox();
    const base = await captureFullState(source);
    const next = await branchFrom(base, (sandbox) => {
      sandbox.admin.deleteDocument('things/a');
    });

    const target = await targetOn(base);
    await promoteFullState(target, base, next);

    const landed = await captureFullState(target);
    expect('things/a' in landed.firestore).toBe(false);
    expect(landed.firestore['things/target-only']).toEqual({ v: 'target' });
  });

  it('lands a Realtime Database value and leaves every other service alone', async () => {
    const source = await populatedSandbox();
    const base = await captureFullState(source);
    const next = await branchFrom(base, (sandbox) => {
      getOrCreateBackend(sandbox).adminSet('rooms/one/title', 'renamed');
    });
    expect(diffFullStates(base, next).map((d) => d.service)).toEqual(['database']);

    const target = await targetOn(base);
    await promoteFullState(target, base, next);

    const landed = await captureFullState(target);
    expect(getOrCreateBackend(target).exportPersistenceState()).toBeDefined();
    expect(diffFullStates(landed, next).map((d) => d.service)).toEqual(['firestore']);
    expect(landed.auth).toEqual(base.auth);
    expect(landed.storage).toEqual(base.storage);
    expect(landed.rules).toEqual(base.rules);
  });

  it('lands a Storage object and leaves every other service alone', async () => {
    const source = await populatedSandbox();
    const base = await captureFullState(source);
    const next = await branchFrom(base, async (sandbox) => {
      await uploadBytes(
        storageRef(getAdminStorageSandbox(sandbox), 'docs/added.txt'),
        new Uint8Array([9, 9]),
        { contentType: 'text/plain', customMetadata: {} },
      );
    });
    expect(diffFullStates(base, next).map((d) => d.service)).toEqual(['storage']);

    const target = await targetOn(base);
    await promoteFullState(target, base, next);

    const landed = await captureFullState(target);
    expect(landed.storage.map((object) => object.path)).toEqual([
      'docs/added.txt',
      'docs/hello.txt',
    ]);
    const added = await getBytes(storageRef(getAdminStorageSandbox(target), 'docs/added.txt'));
    expect([...new Uint8Array(added)]).toEqual([9, 9]);
    expect(landed.auth).toEqual(base.auth);
    expect(landed.database).toEqual(base.database);
    expect(landed.rules).toEqual(base.rules);
  });

  it('lands an auth account and leaves every other service alone', async () => {
    const source = await populatedSandbox();
    const base = await captureFullState(source);
    const next = await branchFrom(base, (sandbox) => {
      authDriver.seedUsers(getAuth(sandbox), [
        { uid: 'bob', email: 'bob@example.com', password: 'secret-bob' },
      ]);
    });
    expect(diffFullStates(base, next).map((d) => d.service)).toEqual(['auth']);

    const target = await targetOn(base);
    await promoteFullState(target, base, next);

    const landed = await captureFullState(target);
    expect(landed.auth.users.map((user) => user.uid).sort()).toEqual(['alice', 'bob']);
    expect(landed.database).toEqual(base.database);
    expect(landed.storage).toEqual(base.storage);
    expect(landed.rules).toEqual(base.rules);
  });

  it('lands a Firestore ruleset and leaves every other service alone', async () => {
    const source = await populatedSandbox();
    const base = await captureFullState(source);
    const next = await branchFrom(base, (sandbox) => {
      getInternalEnv(sandbox).deployRules(CANDIDATE_FIRESTORE_RULES);
    });
    expect(diffFullStates(base, next).map((d) => d.service)).toEqual(['rules']);

    const target = await targetOn(base);
    await promoteFullState(target, base, next);

    const landed = await captureFullState(target);
    expect(landed.rules.firestore).toBe(CANDIDATE_FIRESTORE_RULES);
    expect(landed.rules.database).toEqual(base.rules.database);
    expect(landed.rules.storage).toBe(base.rules.storage);
    expect(landed.auth).toEqual(base.auth);
    expect(landed.database).toEqual(base.database);
    expect(landed.storage).toEqual(base.storage);
  });

  it('writes nothing at all when the branch diverges in no service', async () => {
    const source = await populatedSandbox();
    const base = await captureFullState(source);
    const next = await branchFrom(base, () => {});
    expect(diffFullStates(base, next)).toEqual([]);

    const target = await targetOn(base);
    const before = await captureFullState(target);

    const calls: string[] = [];
    const record = <T extends object, K extends keyof T>(owner: T, name: K, label: string) => {
      const original = owner[name] as unknown as (...args: unknown[]) => unknown;
      owner[name] = ((...args: unknown[]) => {
        calls.push(label);
        return original.apply(owner, args);
      }) as unknown as T[K];
    };
    record(target.admin, 'setDocument', 'setDocument');
    record(target.admin, 'deleteDocument', 'deleteDocument');
    const database = getOrCreateBackend(target);
    record(database, 'adminSet', 'adminSet');
    record(database, 'adminSetPriority', 'adminSetPriority');
    record(database, 'setRules', 'setRules');
    const auth = targetOf(getAuth(target)).backend;
    record(auth, 'seedUsers', 'seedUsers');
    record(auth, 'deleteUser', 'deleteUser');
    record(auth, 'restoreProviderConfig', 'restoreProviderConfig');
    record(getInternalEnv(target), 'deployRules', 'deployRules');

    await promoteFullState(target, base, next);

    expect(calls).toEqual([]);
    expect(await captureFullState(target)).toEqual(before);
  });
});
