import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { doc, getDoc, getFirestore, setDoc } from '../../../src/firestore/index.js';
import { getOrCreateBackend } from '../../../src/database/sandbox/backend-for.js';
import { initializeSandbox } from '../../../src/sandbox/index.js';
import { applyFullState, captureFullState } from '../../../src/sandbox/full-state.js';
import { captureCheckpoint, restoreCheckpoint } from '../../../src/sandbox/checkpoints/index.js';
import { fork, promote } from '../../../src/sandbox/branches/engine.js';
import {
  captureSandboxSnapshot,
  getInternalEnv,
  restoreSandboxSnapshot,
} from '../../../src/sandbox/internal/index.js';
import { seedDocuments, setRules } from '../../../src/firestore/sandbox-controls.js';
import { DEFAULT_OPEN_RULES } from '../../../src/firestore/sandbox/rules-evaluation.js';
import { getFirestore as getAdminFirestore } from '../../../src/sandbox/admin-firestore/index.js';
import {
  deployStorageBucketRules,
  getActiveStorageRulesResolution,
  getDefaultStorageRulesResolution,
  lockUndeployedStorageBuckets,
  replaceStorageRules,
} from '../../../src/storage/internal.js';

const CUSTOM_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /items/{id} { allow read, write: if request.auth != null; }',
  '  }',
  '}',
].join('\n');

const STORAGE_RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /files/{name} { allow read, write: if request.auth != null; }',
  '  }',
  '}',
].join('\n');

const BUCKET_STORAGE_RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /{allPaths=**} { allow read, write: if true; }',
  '  }',
  '}',
].join('\n');

describe('explicit rules tracking across Firestore and Storage', () => {
  it('distinguishes built-in default Firestore rules from explicitly installed rules', () => {
    const sandbox = initializeSandbox();
    const env = getInternalEnv(sandbox);

    expect(env.getRules()).toBe(DEFAULT_OPEN_RULES);
    expect(env.hasExplicitRules()).toBe(false);
    expect(env.getExplicitRules()).toBeNull();

    // Seeding documents preserves implicit default rules rather than promoting them.
    seedDocuments(sandbox, { 'items/a': { name: 'a' } });
    expect(env.hasExplicitRules()).toBe(false);
    expect(env.getExplicitRules()).toBeNull();

    const adminDb = getAdminFirestore(sandbox.withAuth(null));
    adminDb.seed({ documents: { 'items/b': { name: 'b' } } });
    expect(env.hasExplicitRules()).toBe(false);
    expect(env.getExplicitRules()).toBeNull();

    // Explicitly deploying even the open default marks Firestore rules explicit.
    setRules(sandbox, DEFAULT_OPEN_RULES);
    expect(env.hasExplicitRules()).toBe(true);
    expect(env.getExplicitRules()).toBe(DEFAULT_OPEN_RULES);

    // Updating to custom rules reflects the latest explicit source.
    setRules(sandbox, CUSTOM_FIRESTORE_RULES);
    expect(env.hasExplicitRules()).toBe(true);
    expect(env.getExplicitRules()).toBe(CUSTOM_FIRESTORE_RULES);

    // Clearing rules or resetting the sandbox clears explicitness.
    env.deployRules('');
    expect(env.hasExplicitRules()).toBe(false);
    expect(env.getExplicitRules()).toBeNull();

    setRules(sandbox, CUSTOM_FIRESTORE_RULES);
    sandbox.reset();
    expect(getInternalEnv(sandbox).hasExplicitRules()).toBe(false);
    expect(getInternalEnv(sandbox).getExplicitRules()).toBeNull();
  });

  it('reads active Storage rules without opening Storage or synthesizing defaults', async () => {
    const sandbox = initializeSandbox();

    expect(getDefaultStorageRulesResolution(sandbox)).toBeNull();
    expect(getActiveStorageRulesResolution(sandbox)).toBeNull();

    // Locking or opening undeployed buckets does not install synthetic rules.
    lockUndeployedStorageBuckets(sandbox, 'allow');
    expect(getDefaultStorageRulesResolution(sandbox)).toBeNull();
    expect(getActiveStorageRulesResolution(sandbox, 'demo.appspot.com')).toBeNull();

    // Unnamed default Storage rules appear via both accessors.
    await replaceStorageRules(sandbox, STORAGE_RULES, {});
    expect(getDefaultStorageRulesResolution(sandbox)?.source).toBe(STORAGE_RULES);
    expect(getActiveStorageRulesResolution(sandbox)?.source).toBe(STORAGE_RULES);

    // Per-bucket default rules take precedence when the default bucket name is known.
    deployStorageBucketRules(sandbox, 'demo.appspot.com', BUCKET_STORAGE_RULES);
    expect(getDefaultStorageRulesResolution(sandbox)?.source).toBe(STORAGE_RULES);
    expect(getActiveStorageRulesResolution(sandbox, 'demo.appspot.com')?.source).toBe(
      BUCKET_STORAGE_RULES,
    );

    // Removing both restores null.
    deployStorageBucketRules(sandbox, 'demo.appspot.com', null);
    await replaceStorageRules(sandbox, null, {});
    expect(getDefaultStorageRulesResolution(sandbox)).toBeNull();
    expect(getActiveStorageRulesResolution(sandbox, 'demo.appspot.com')).toBeNull();
  });

  it('preserves implicit vs explicit Firestore rules across checkpoints and full-state round-trips', async () => {
    const implicitSandbox = initializeSandbox();
    const implicitState = await captureFullState(implicitSandbox);
    expect(implicitState.rules.firestore).toBe('');

    const checkpoint = await captureCheckpoint(implicitSandbox, 'implicit-base');
    expect(checkpoint.state.rules.firestore).toBe('');

    // Restoring an implicit checkpoint over a sandbox with explicit rules clears explicitness
    // while keeping built-in open default rules functional for unauthenticated client operations.
    const target = initializeSandbox();
    setRules(target, CUSTOM_FIRESTORE_RULES);
    expect(getInternalEnv(target).hasExplicitRules()).toBe(true);

    await restoreCheckpoint(target, checkpoint);
    expect(getInternalEnv(target).hasExplicitRules()).toBe(false);
    expect(getInternalEnv(target).getExplicitRules()).toBeNull();
    expect(getInternalEnv(target).getRules()).toBe(DEFAULT_OPEN_RULES);

    const openDb = getFirestore(target);
    await setDoc(doc(openDb, 'items/open-1'), { ok: true });
    expect((await getDoc(doc(openDb, 'items/open-1'))).data()).toEqual({ ok: true });

    // Explicit rules round-trip with explicitness and source preserved.
    const explicitSandbox = initializeSandbox();
    setRules(explicitSandbox, CUSTOM_FIRESTORE_RULES);
    const explicitCheckpoint = await captureCheckpoint(explicitSandbox, 'explicit-base');
    expect(explicitCheckpoint.state.rules.firestore).toBe(CUSTOM_FIRESTORE_RULES);

    const explicitTarget = initializeSandbox();
    await restoreCheckpoint(explicitTarget, explicitCheckpoint);
    expect(getInternalEnv(explicitTarget).hasExplicitRules()).toBe(true);
    expect(getInternalEnv(explicitTarget).getExplicitRules()).toBe(CUSTOM_FIRESTORE_RULES);
  });

  it('preserves implicit vs explicit Firestore rules across branch fork, promote, and rollback', async () => {
    const live = initializeSandbox();
    const baseState = await captureFullState(live);
    const branch = await fork(baseState);
    expect(getInternalEnv(branch.sandbox).hasExplicitRules()).toBe(false);
    expect(getInternalEnv(branch.sandbox).getExplicitRules()).toBeNull();
    expect(getInternalEnv(branch.sandbox).getRules()).toBe(DEFAULT_OPEN_RULES);

    // Writing a Firestore doc on the implicit branch still works under default open rules.
    const branchDb = getFirestore(branch.sandbox);
    await setDoc(doc(branchDb, 'items/from-branch'), { v: 1 });
    await promote(branch, live);
    expect(getInternalEnv(live).hasExplicitRules()).toBe(false);
    expect(getInternalEnv(live).getExplicitRules()).toBeNull();

    // A failed promote rollback onto an implicit live sandbox must not promote default rules.
    const failingBranch = await fork(await captureFullState(live));
    getOrCreateBackend(failingBranch.sandbox).adminSet('nodes/fail', 'trigger-rollback');
    const liveRtdb = getOrCreateBackend(live);
    const originalAdminSet = liveRtdb.adminSet.bind(liveRtdb);
    liveRtdb.adminSet = () => {
      throw new Error('simulated promote failure');
    };
    try {
      await expect(promote(failingBranch, live)).rejects.toThrow('simulated promote failure');
    } finally {
      liveRtdb.adminSet = originalAdminSet;
    }
    expect(getInternalEnv(live).hasExplicitRules()).toBe(false);
    expect(getInternalEnv(live).getExplicitRules()).toBeNull();
    expect(getInternalEnv(live).getRules()).toBe(DEFAULT_OPEN_RULES);

    // Promoting explicit rules onto an implicit live sandbox marks rules explicit.
    const rulesBranch = await fork(await captureFullState(live));
    setRules(rulesBranch.sandbox, CUSTOM_FIRESTORE_RULES);
    await promote(rulesBranch, live);
    expect(getInternalEnv(live).hasExplicitRules()).toBe(true);
    expect(getInternalEnv(live).getExplicitRules()).toBe(CUSTOM_FIRESTORE_RULES);

    // Promoting a reset back to implicit rules clears explicitness on the target.
    const revertBranch = await fork(await captureFullState(live));
    await applyFullState(revertBranch.sandbox, await captureFullState(initializeSandbox()));
    await promote(revertBranch, live);
    expect(getInternalEnv(live).hasExplicitRules()).toBe(false);
    expect(getInternalEnv(live).getExplicitRules()).toBeNull();
    expect(getInternalEnv(live).getRules()).toBe(DEFAULT_OPEN_RULES);
  });

  it('preserves implicit vs explicit Firestore rules across snapshot() / loadSnapshot()', async () => {
    const implicitSandbox = initializeSandbox();
    const implicitSnap = implicitSandbox.snapshot();
    expect(implicitSnap.firestoreRules).toBeUndefined();

    const target = initializeSandbox();
    setRules(target, CUSTOM_FIRESTORE_RULES);
    target.loadSnapshot(implicitSnap);
    expect(getInternalEnv(target).hasExplicitRules()).toBe(false);
    expect(getInternalEnv(target).getExplicitRules()).toBeNull();
    expect(getInternalEnv(target).getRules()).toBe(DEFAULT_OPEN_RULES);
    await setDoc(doc(getFirestore(target), 'items/after-load'), { ok: true });

    const explicitSandbox = initializeSandbox();
    setRules(explicitSandbox, CUSTOM_FIRESTORE_RULES);
    const explicitSnap = explicitSandbox.snapshot();
    expect(explicitSnap.firestoreRules).toBe(CUSTOM_FIRESTORE_RULES);

    const explicitTarget = initializeSandbox();
    explicitTarget.loadSnapshot(explicitSnap);
    expect(getInternalEnv(explicitTarget).hasExplicitRules()).toBe(true);
    expect(getInternalEnv(explicitTarget).getExplicitRules()).toBe(CUSTOM_FIRESTORE_RULES);
  });

  it('preserves implicit vs explicit Firestore rules across captureSandboxSnapshot / restoreSandboxSnapshot', async () => {
    const implicitSandbox = initializeSandbox();
    const implicitSnapshot = await captureSandboxSnapshot(implicitSandbox);
    expect(implicitSnapshot.rules.firestore).toBeUndefined();

    const target = initializeSandbox();
    setRules(target, CUSTOM_FIRESTORE_RULES);
    const { refusals } = await restoreSandboxSnapshot(target, implicitSnapshot, { merge: false });
    expect(refusals).toEqual([]);
    expect(getInternalEnv(target).hasExplicitRules()).toBe(false);
    expect(getInternalEnv(target).getExplicitRules()).toBeNull();
    expect(getInternalEnv(target).getRules()).toBe(DEFAULT_OPEN_RULES);
    await setDoc(doc(getFirestore(target), 'items/after-restore'), { ok: true });

    const explicitSandbox = initializeSandbox();
    setRules(explicitSandbox, CUSTOM_FIRESTORE_RULES);
    const explicitSnapshot = await captureSandboxSnapshot(explicitSandbox);
    expect(explicitSnapshot.rules.firestore?.['(default)']).toBe(CUSTOM_FIRESTORE_RULES);

    const explicitTarget = initializeSandbox();
    const explicitRestore = await restoreSandboxSnapshot(explicitTarget, explicitSnapshot, {
      merge: false,
    });
    expect(explicitRestore.refusals).toEqual([]);
    expect(getInternalEnv(explicitTarget).hasExplicitRules()).toBe(true);
    expect(getInternalEnv(explicitTarget).getExplicitRules()).toBe(CUSTOM_FIRESTORE_RULES);
  });
});
