import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../../src/sandbox/index.js';
import { getInternalEnv } from '../../../src/sandbox/internal/index.js';
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
});
