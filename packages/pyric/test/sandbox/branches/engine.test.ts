/**
 * The branch engine: fork, apply, diff, promote, discard.
 *
 * A branch carries the whole sandbox, so every case here plants a divergence
 * in one service and proves the engine reports it under that service's name
 * and lands it on promote. The Firestore cases that predate the other services
 * stay: they pin the copy-on-write isolation the fork has always promised.
 */
import { describe, it, expect } from 'bun:test';

import { getAuth } from '../../../src/auth/instances.js';
import { sandbox as authDriver } from '../../../src/auth/sandbox/driver.js';
import { getOrCreateBackend } from '../../../src/database/sandbox/backend-for.js';
import {
  apply,
  captureFullState,
  diff,
  discard,
  fork,
  initializeSandbox,
  promote,
  type LocalSandbox,
} from '../../../src/sandbox/index.js';
import { getInternalEnv } from '../../../src/sandbox/internal/sandbox-impl.js';
import { getAdminStorageSandbox, getStorageRulesResolution } from '../../../src/storage/internal.js';
import { getBytes, ref as storageRef, uploadBytes } from '../../../src/storage/index.js';
import {
  CANDIDATE_FIRESTORE_RULES,
  DATABASE_RULES,
  FIRESTORE_RULES,
  populatedSandbox,
  STORAGE_RULES,
} from './fixtures.js';

/** Capture a fresh stream of write events produced by `fn` on a throwaway sandbox. */
function captureEvents(
  base: Record<string, Record<string, unknown>>,
  fn: (env: ReturnType<typeof getInternalEnv>) => void,
) {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.seed({ rules: FIRESTORE_RULES, documents: base });
  fn(env);
  return sandbox.history();
}

/** A branch forked from `live`'s current full state. */
async function forkOf(live: LocalSandbox) {
  return fork(await captureFullState(live));
}

/** The divergences one diff reports for one service. */
function forService(
  divergences: Awaited<ReturnType<typeof diff>>,
  service: string,
) {
  return divergences.filter((divergence) => divergence.service === service);
}

describe('the branch engine, across every service', () => {
  it('forks a sandbox that reads identically to the one it was forked from', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);

    expect(await captureFullState(branch.sandbox)).toEqual(await captureFullState(live));
  });

  it('reports and promotes a Firestore divergence planted on the branch', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);
    branch.sandbox.admin.setDocument('things/a', { v: 42 });

    const divergences = forService(await diff(branch, live), 'firestore');
    expect(divergences.map((d) => 'path' in d && d.path)).toContain('things/a');

    await promote(branch, live);
    expect(getInternalEnv(live).snapshot()['things/a']).toEqual({ v: 42 });
    expect(getInternalEnv(live).snapshot()['things/keep']).toEqual({ v: 100 });
  });

  it('reports and promotes a Realtime Database divergence planted on the branch', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);
    getOrCreateBackend(branch.sandbox).adminSet('rooms/one/title', 'renamed');

    const divergences = forService(await diff(branch, live), 'database');
    expect(divergences).toHaveLength(1);
    expect('path' in divergences[0]! && divergences[0]!.path).toBe('rooms/one/title');
    expect('after' in divergences[0]! && divergences[0]!.after).toBe('renamed');

    await promote(branch, live);
    expect(getOrCreateBackend(live).adminGet('rooms/one')).toEqual({ title: 'renamed' });
  });

  it('reports and promotes a Storage divergence planted on the branch', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);
    await uploadBytes(
      storageRef(getAdminStorageSandbox(branch.sandbox), 'docs/added.bin'),
      new Uint8Array([9, 9]),
      { contentType: 'application/octet-stream', customMetadata: { owner: 'bob' } },
    );

    const divergences = forService(await diff(branch, live), 'storage');
    expect(divergences.map((d) => 'path' in d && d.path)).toContain('docs/added.bin');

    await promote(branch, live);
    const landed = await getBytes(storageRef(getAdminStorageSandbox(live), 'docs/added.bin'));
    expect(Array.from(new Uint8Array(landed))).toEqual([9, 9]);
  });

  it('reports and promotes an auth divergence planted on the branch, keyed by uid', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);
    authDriver.seedUsers(getAuth(branch.sandbox), [
      { uid: 'bob', email: 'bob@example.com', password: 'secret-bob', customClaims: { admin: true } },
    ]);

    const divergences = forService(await diff(branch, live), 'auth');
    expect(divergences.map((d) => 'path' in d && d.path)).toContain('bob');

    await promote(branch, live);
    const users = authDriver.exportUsers(getAuth(live));
    expect(users.map((user) => user.uid).sort()).toEqual(['alice', 'bob']);
    expect(users.find((user) => user.uid === 'bob')?.customClaims).toEqual({ admin: true });
  });

  it('reports and promotes a rules divergence planted on the branch', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);
    getOrCreateBackend(branch.sandbox).setRules({ rules: { '.read': false, '.write': false } });

    const divergences = forService(await diff(branch, live), 'rules');
    expect(divergences.map((d) => 'path' in d && d.path)).toContain('database');

    await promote(branch, live);
    expect(getOrCreateBackend(live).getActiveRules()).toEqual({
      rules: { '.read': false, '.write': false },
    });
  });

  it('reports a divergence planted on live, not on the branch', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);

    live.admin.setDocument('things/a', { v: 7 });
    getOrCreateBackend(live).adminSet('rooms/one/title', 'moved on live');
    authDriver.seedUsers(getAuth(live), [
      { uid: 'carol', email: 'carol@example.com', password: 'secret-carol' },
    ]);

    const divergences = await diff(branch, live);
    expect(forService(divergences, 'firestore').map((d) => 'path' in d && d.path)).toContain(
      'things/a',
    );
    expect(forService(divergences, 'database').map((d) => 'path' in d && d.path)).toContain(
      'rooms/one/title',
    );
    expect(forService(divergences, 'auth').map((d) => 'path' in d && d.path)).toContain('carol');
  });

  it('reports nothing when the branch and the reference hold the same state', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);
    expect(await diff(branch, live)).toEqual([]);
  });

  it('leaves live byte identical when the branch is discarded', async () => {
    const live = await populatedSandbox();
    const before = JSON.stringify(await captureFullState(live));

    const branch = await forkOf(live);
    branch.sandbox.admin.setDocument('things/new', { v: 1 });
    getOrCreateBackend(branch.sandbox).adminSet('rooms/two', { title: 'second' });
    authDriver.seedUsers(getAuth(branch.sandbox), [
      { uid: 'dave', email: 'dave@example.com', password: 'secret-dave' },
    ]);
    await uploadBytes(
      storageRef(getAdminStorageSandbox(branch.sandbox), 'docs/branch.bin'),
      new Uint8Array([4]),
    );

    discard(branch);

    expect(JSON.stringify(await captureFullState(live))).toBe(before);
    expect(branch.discarded).toBe(true);
    expect(() => discard(branch)).not.toThrow();
  });

  it('forks with candidate Firestore rules that replace only the Firestore rules', async () => {
    const live = await populatedSandbox();
    const branch = await fork(await captureFullState(live), CANDIDATE_FIRESTORE_RULES);

    expect(getInternalEnv(branch.sandbox).getRules()).toBe(CANDIDATE_FIRESTORE_RULES);
    expect(getOrCreateBackend(branch.sandbox).getActiveRules()).toEqual(DATABASE_RULES);
    expect(getStorageRulesResolution(getAdminStorageSandbox(branch.sandbox))?.source).toBe(
      STORAGE_RULES,
    );
    expect(getInternalEnv(live).getRules()).toBe(FIRESTORE_RULES);
  });

  it('forks with candidate rules for each service, named one by one', async () => {
    const live = await populatedSandbox();
    const candidateDatabase = { rules: { '.read': false, '.write': false } };
    const branch = await fork(await captureFullState(live), {
      firestore: CANDIDATE_FIRESTORE_RULES,
      database: candidateDatabase,
    });

    expect(getInternalEnv(branch.sandbox).getRules()).toBe(CANDIDATE_FIRESTORE_RULES);
    expect(getOrCreateBackend(branch.sandbox).getActiveRules()).toEqual(candidateDatabase);
  });

  it('reads a Realtime Database ruleset passed as one candidate rules string', async () => {
    const live = await populatedSandbox();
    const source = JSON.stringify({ rules: { '.read': false, '.write': false } });
    const branch = await fork(await captureFullState(live), source);

    expect(getOrCreateBackend(branch.sandbox).getActiveRules()).toEqual({
      rules: { '.read': false, '.write': false },
    });
    expect(getInternalEnv(branch.sandbox).getRules()).toBe(FIRESTORE_RULES);
  });

  it('restores the target and rethrows when a promotion write fails part of the way through', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);
    branch.sandbox.admin.setDocument('things/a', { v: 42 });
    getOrCreateBackend(branch.sandbox).adminSet('rooms/one/title', 'renamed');

    const before = JSON.stringify(await captureFullState(live));
    const refusal = new Error('the target refuses this write');
    const backend = getOrCreateBackend(live);
    const realAdminSet = backend.adminSet.bind(backend);
    backend.adminSet = () => {
      throw refusal;
    };

    let thrown: unknown = null;
    try {
      await promote(branch, live);
    } catch (error) {
      thrown = error;
    }
    backend.adminSet = realAdminSet;

    expect(thrown).toBe(refusal);
    expect(JSON.stringify(await captureFullState(live))).toBe(before);
    expect(branch.discarded).toBe(false);
  });

  it('applies captured writes to the branch without touching the source', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);

    apply(
      branch,
      captureEvents({ 'things/a': { v: 1 } }, (env) => {
        env.execute({ method: 'update', path: 'things/a', auth: null, data: { v: 2 } });
        env.execute({ method: 'set', path: 'things/b', auth: null, data: { v: 7 } });
      }),
    );

    const state = getInternalEnv(branch.sandbox).snapshot();
    expect(state['things/a']).toEqual({ v: 2 });
    expect(state['things/b']).toEqual({ v: 7 });
    expect(getInternalEnv(live).snapshot()['things/a']).toEqual({ v: 1 });
    expect(getInternalEnv(live).snapshot()['things/b']).toBeUndefined();
  });

  it('isolates the branch from a live write made after the fork', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);

    live.admin.setDocument('things/a', { v: 1000 });
    live.admin.setDocument('things/late', { v: 5 });

    expect(getInternalEnv(branch.sandbox).snapshot()['things/a']).toEqual({ v: 1 });
    expect(getInternalEnv(branch.sandbox).snapshot()['things/late']).toBeUndefined();
  });

  it('does not corrupt live or a sibling branch when a raw branch read is mutated', async () => {
    const live = initializeSandbox();
    getInternalEnv(live).seed({
      rules: FIRESTORE_RULES,
      documents: { 'things/a': { tags: ['x', 'y'], meta: { n: 1 } } },
    });
    const base = await captureFullState(live);
    const first = await fork(base);
    const second = await fork(base);

    const read = getInternalEnv(first.sandbox).snapshot()['things/a'] as {
      tags: string[];
      meta: { n: number };
    };
    read.tags.push('CORRUPT');
    read.meta.n = 999;

    const original = { tags: ['x', 'y'], meta: { n: 1 } };
    expect(getInternalEnv(live).snapshot()['things/a']).toEqual(original);
    expect(getInternalEnv(second.sandbox).snapshot()['things/a']).toEqual(original);
    expect(base.firestore['things/a']).toEqual(original);
  });

  it('removes on promote a document the branch deleted', async () => {
    const live = await populatedSandbox();
    const branch = await forkOf(live);
    getInternalEnv(branch.sandbox).adminDeleteDocument('things/a');

    await promote(branch, live);

    expect(getInternalEnv(live).snapshot()['things/a']).toBeUndefined();
    expect(getInternalEnv(live).snapshot()['things/keep']).toEqual({ v: 100 });
    expect(branch.discarded).toBe(true);
    expect(() => apply(branch, [])).toThrow();
  });

  it('diffs against a bare captured state, not only a live sandbox', async () => {
    const live = await populatedSandbox();
    const baseline = await captureFullState(live);
    const branch = await fork(baseline);
    branch.sandbox.admin.setDocument('things/a', { v: 2 });

    const divergences = await diff(branch, baseline);
    expect(forService(divergences, 'firestore').map((d) => 'path' in d && d.path)).toContain(
      'things/a',
    );
  });
});
