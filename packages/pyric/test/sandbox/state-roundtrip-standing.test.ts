/**
 * Standing mechanical check for STATE-ROUNDTRIP invariants across Sandbox
 * snapshot/loadSnapshot, incremental shard persistence, checkpoints, branches,
 * reset/resetAll (registered and unregistered services), legacy v2 migration,
 * and service/checkpoint validators.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  bundleRecords,
  createMemoryBackend,
  deserializeFromBuckets,
  discard,
  fork,
  getClock,
  initializeSandbox,
  parseBundle,
  promote,
  type LocalSandbox,
  type PersistenceBackend,
} from '../../src/sandbox/index.js';
import { captureFullState } from '../../src/sandbox/full-state.js';
import {
  captureCheckpoint,
  restoreCheckpoint,
} from '../../src/sandbox/checkpoints/index.js';
import { setRules as setFirestoreRules } from '../../src/firestore/sandbox-controls.js';
import { getActiveRules as getActiveDatabaseRules } from '../../src/database/sandbox-controls.js';
import {
  assertCheckpointState,
  decodeImportBundle,
  persistedServiceHasData,
  validatePersistedService,
  validateRtdbImportRecord,
} from '../../src/sandbox/internal/index.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  sandbox as authSandbox,
} from '../../src/auth/index.js';
import {
  getAdminDatabase,
  getDatabase,
  get,
  ref,
  set,
  setPriority,
  setWithPriority,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';
import { heldDatabaseInstances } from '../../src/database/internal.js';
import { getBytes, ref as storageRef, uploadBytes } from '../../src/storage/index.js';
import { getAdminStorageSandbox, replaceStorageRules } from '../../src/storage/internal.js';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{itemId} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const DEFAULT_RTDB_RULES = {
  rules: {
    items: {
      $id: {
        '.read': "auth != null && data.getPriority() === 42 && auth.token.roles[0] === 'editor'",
        '.write': 'auth != null',
      },
    },
    orgs: {
      $orgId: {
        '.read': 'auth != null',
        '.write': 'auth != null',
      },
    },
  },
};

const SCALAR_ROOT_RULES = {
  rules: {
    '.read': "auth != null && data.isString() && data.getPriority() === 15",
    '.write': 'auth != null',
  },
};

const RULES_ONLY_INSTANCE_RULES = {
  rules: {
    users: {
      $uid: {
        '.read': 'auth != null && auth.uid === $uid',
        '.write': 'auth != null && auth.uid === $uid',
      },
    },
  },
};

let storageSeq = 1;

async function buildMaximalSandbox(backend?: PersistenceBackend, persistKey?: string): Promise<LocalSandbox> {
  const sb = initializeSandbox();
  getAdminStorageSandbox(sb, { dbName: `state-roundtrip-standing-${storageSeq++}` });
  if (backend && persistKey) {
    await sb.enablePersistence({ key: persistKey, injectedBackend: backend, flushIntervalMs: 60_000 });
  }
  getClock(sb).set(1_700_000_000_000);

  // 1. Firestore documents + rules
  setFirestoreRules(sb, FIRESTORE_RULES);
  sb.admin.setDocument('docs/d1', { title: 'Spec', tags: ['v1', 'core'], meta: { active: true } });

  // 2. Auth: both anonymous and non-anonymous users with nested customClaims
  const auth = getAuth(sb);
  authSandbox.seedUsers(auth, [
    {
      uid: 'u-anon',
      email: '',
      password: '',
      providerId: 'anonymous',
      customClaims: { roles: ['guest'], scopes: { read: true } },
    },
    {
      uid: 'u-editor',
      email: 'editor@example.com',
      password: 'password123',
      displayName: 'Editor',
      emailVerified: true,
      customClaims: { roles: ['editor'], org: { id: 'o1', tiers: [1, 2] } },
    },
    {
      uid: 'u-oauth',
      email: 'oauth@example.com',
      providerId: 'google.com',
      customClaims: { roles: ['member'], org: { id: 'o2' } },
    },
  ]);

  // 3. Default RTDB: arrays with element priorities + deep (> depth 4) shards + rules
  const defaultAdmin = getAdminDatabase(sb);
  rtdbSandbox.setRules(defaultAdmin, DEFAULT_RTDB_RULES);
  await set(ref(defaultAdmin, 'items'), ['alpha', 'beta']);
  await setPriority(ref(defaultAdmin, 'items/0'), 42);
  await setWithPriority(ref(defaultAdmin, 'orgs/o1/teams/t1/members/m1'), { role: 'lead' }, 'p-lead');

  // 4. Named RTDB instance 1 (`scalar-rtdb`): scalar root + priority + rules
  const scalarAdmin = getAdminDatabase(sb, 'https://scalar-rtdb.firebaseio.com');
  rtdbSandbox.setRules(scalarAdmin, SCALAR_ROOT_RULES);
  await setWithPriority(ref(scalarAdmin, '/'), 'active-banner', 15);

  // 5. Named RTDB instance 2 (`rules-only-rtdb`): empty data tree + deployed rules
  const rulesOnlyAdmin = getAdminDatabase(sb, 'https://rules-only-rtdb.firebaseio.com');
  rtdbSandbox.setRules(rulesOnlyAdmin, RULES_ONLY_INSTANCE_RULES);

  // 6. Storage bytes + rules
  const storage = getAdminStorageSandbox(sb);
  await replaceStorageRules(sb, STORAGE_RULES);
  await uploadBytes(storageRef(storage, 'items/blob-1.txt'), new TextEncoder().encode('maximal-payload'), {
    contentType: 'text/plain',
    customMetadata: { env: 'standing' },
  });

  if (backend) {
    await sb.flush();
  }
  return sb;
}

async function assertMaximalCapabilities(sb: LocalSandbox): Promise<void> {
  expect(sb.admin.getDocument('docs/d1')).toEqual({
    title: 'Spec',
    tags: ['v1', 'core'],
    meta: { active: true },
  });

  // Sign in non-anonymous user and verify customClaims reach minted token and RTDB rules
  const auth = getAuth(sb);
  const cred = await signInWithEmailAndPassword(auth, 'editor@example.com', 'password123');
  const tokenResult = await cred.user.getIdTokenResult();
  expect(tokenResult.claims.roles).toEqual(['editor']);
  expect(tokenResult.claims.org).toEqual({ id: 'o1', tiers: [1, 2] });

  const clientDefault = getDatabase(sb);
  const item0 = await get(ref(clientDefault, 'items/0'));
  expect(item0.val()).toBe('alpha');
  expect(item0.priority).toBe(42);

  // Child write into normalized array preserves sibling element
  const adminDefault = getAdminDatabase(sb);
  await set(ref(adminDefault, 'items/1'), 'gamma');
  expect((await get(ref(adminDefault, 'items'))).val()).toEqual(['alpha', 'gamma']);
  await set(ref(adminDefault, 'items/1'), 'beta');

  // Deep shard read + priority
  const deepSnap = await get(ref(clientDefault, 'orgs/o1/teams/t1/members/m1'));
  expect(deepSnap.val()).toEqual({ role: 'lead' });
  expect(deepSnap.priority).toBe('p-lead');

  // Scalar root named instance read under rules
  const clientScalar = getDatabase(sb, 'https://scalar-rtdb.firebaseio.com');
  const scalarSnap = await get(ref(clientScalar, '/'));
  expect(scalarSnap.val()).toBe('active-banner');
  expect(scalarSnap.priority).toBe(15);

  // Rules-only named instance enforces uid-scoped rules
  const clientRulesOnly = getDatabase(sb, 'https://rules-only-rtdb.firebaseio.com');
  await set(ref(clientRulesOnly, 'users/u-editor'), { ok: true });
  await expect(get(ref(clientRulesOnly, 'users/other-uid'))).rejects.toThrow(/PERMISSION_DENIED/);
  await set(ref(getAdminDatabase(sb, 'https://rules-only-rtdb.firebaseio.com'), 'users/u-editor'), null);
}

describe('STATE-ROUNDTRIP standing kitchen-sink harness', () => {
  it('preserves maximal state across snapshot -> mutate -> loadSnapshot, evicts ghost named instances, and isolates customClaims', async () => {
    const persistBackend = createMemoryBackend();
    const sb = await buildMaximalSandbox(persistBackend, 'standing-snap');
    try {
      const snap = sb.snapshot();

      // Mutate caller's exported snapshot in-place (including unnormalized JSON array injection for loadSnapshot)
      const snapCloneForRestore = structuredClone(snap);
      (
        (snapCloneForRestore.services.rtdb as Record<string, unknown>).data as Record<string, unknown>
      ).items = ['alpha', 'beta'];

      const authSnap = snap.services.auth as {
        users: Array<{ uid: string; customClaims?: { roles: string[]; org?: { id: string } } }>;
      };
      for (const user of authSnap.users) {
        user.customClaims?.roles.push('mutated-caller');
        if (user.customClaims?.org) user.customClaims.org.id = 'mutated-org';
      }

      // Live Auth customClaims must remain uncorrupted by snapshot mutation
      expect(authSandbox.exportUsers(getAuth(sb)).find((u) => u.uid === 'u-editor')?.customClaims).toEqual({
        roles: ['editor'],
        org: { id: 'o1', tiers: [1, 2] },
      });

      // Dirty the live sandbox across services, including a ghost named RTDB instance
      sb.admin.setDocument('docs/ghost', { stale: true });
      const ghostNamed = getAdminDatabase(sb, 'https://ghost-ephemeral-rtdb.firebaseio.com');
      await set(ref(ghostNamed, 'items/g1'), 'ghost-data');
      await set(ref(getAdminDatabase(sb, 'https://scalar-rtdb.firebaseio.com'), '/'), { replacedWithObject: true });
      await sb.flush();

      expect(await persistBackend.listRecords('standing-snap')).toContain('rtdb:i:ghost-ephemeral-rtdb');
      expect(heldDatabaseInstances(sb)).toContain('ghost-ephemeral-rtdb');

      // Load snapshot and mutate input object afterwards to check import non-aliasing
      sb.loadSnapshot(snapCloneForRestore);
      const restoreAuthUsers = (
        snapCloneForRestore.services.auth as {
          users: Array<{ customClaims?: { roles: string[] } }>;
        }
      ).users;
      for (const u of restoreAuthUsers) u.customClaims?.roles.push('post-load-tamper');
      await sb.flush();

      // Ghost named instance is evicted from snapshot(), heldDatabaseInstances(), and persisted headers
      expect(heldDatabaseInstances(sb).sort()).toEqual(['rules-only-rtdb', 'scalar-rtdb']);
      const postLoadRtdb = sb.snapshot().services.rtdb as { instances?: Record<string, unknown> };
      expect(Object.keys(postLoadRtdb.instances ?? {}).sort()).toEqual(['rules-only-rtdb', 'scalar-rtdb']);
      expect(await persistBackend.listRecords('standing-snap')).not.toContain('rtdb:i:ghost-ephemeral-rtdb');
      expect(sb.admin.getDocument('docs/ghost')).toBeNull();

      await assertMaximalCapabilities(sb);

      // Reopen into a fresh sandbox from persisted records and verify full round-trip fidelity
      const reopened = initializeSandbox();
      try {
        await reopened.enablePersistence({
          key: 'standing-snap',
          injectedBackend: persistBackend,
          flushIntervalMs: 60_000,
        });
        expect(heldDatabaseInstances(reopened).sort()).toEqual(['rules-only-rtdb', 'scalar-rtdb']);
        await assertMaximalCapabilities(reopened);
      } finally {
        reopened.dispose();
      }
    } finally {
      sb.dispose();
    }
  });

  it('preserves maximal state across checkpoints and branch fork/promote including scalar roots, arrays, Storage, and named RTDB rules', async () => {
    const source = await buildMaximalSandbox();
    const target = initializeSandbox();
    getAdminStorageSandbox(target, { dbName: `state-roundtrip-standing-${storageSeq++}` });
    try {
      // Dirty target with a ghost named RTDB instance before checkpoint restore
      await set(ref(getAdminDatabase(target, 'https://ghost-cp-rtdb.firebaseio.com'), 'x'), 1);

      const cp = await captureCheckpoint(source);
      assertCheckpointState(cp.state);
      await restoreCheckpoint(target, cp);

      expect(getClock(target).now()).toBe(1_700_000_000_000);
      expect(heldDatabaseInstances(target).sort()).toEqual(['rules-only-rtdb', 'scalar-rtdb']);
      await assertMaximalCapabilities(target);
      const bytes = await getBytes(storageRef(getAdminStorageSandbox(target), 'items/blob-1.txt'));
      expect(new TextDecoder().decode(bytes)).toBe('maximal-payload');

      // Fork a branch from target, update scalar root + named instance rules, and promote back
      const branch = await fork(await captureFullState(target));
      try {
        const branchScalar = getAdminDatabase(branch.sandbox, 'https://scalar-rtdb.firebaseio.com');
        await setWithPriority(ref(branchScalar, '/'), 'promoted-banner', 15);
        const branchRulesOnly = getAdminDatabase(branch.sandbox, 'https://rules-only-rtdb.firebaseio.com');
        rtdbSandbox.setRules(branchRulesOnly, { rules: { '.read': false, '.write': false } });
        await promote(branch, target);
      } finally {
        discard(branch);
      }

      expect((await get(ref(getAdminDatabase(target, 'https://scalar-rtdb.firebaseio.com'), '/'))).val()).toBe(
        'promoted-banner',
      );
      expect(getActiveDatabaseRules(getAdminDatabase(target, 'https://rules-only-rtdb.firebaseio.com'))).toEqual({
        rules: { '.read': false, '.write': false },
      });
    } finally {
      source.dispose();
      target.dispose();
    }
  });

  it('purges persisted shards across reset and resetAll (both registered and unregistered RTDB) and migrates legacy v2 trees', async () => {
    const backend = createMemoryBackend();
    const seeded = await buildMaximalSandbox(backend, 'standing-reset');
    seeded.dispose();

    // Unregistered RTDB resetAll + flush wipes all rtdb:* shards across default and named instances
    const unregReset = initializeSandbox();
    await unregReset.enablePersistence({ key: 'standing-reset', injectedBackend: backend, flushIntervalMs: 60_000 });
    await unregReset.resetAll();
    await unregReset.flush();
    unregReset.dispose();

    const remainingRtdb = (await backend.listRecords('standing-reset')).filter((id) => id.startsWith('rtdb:'));
    expect(remainingRtdb).toEqual([]);

    const reopenedEmpty = initializeSandbox();
    await reopenedEmpty.enablePersistence({ key: 'standing-reset', injectedBackend: backend, flushIntervalMs: 60_000 });
    expect((await get(ref(getAdminDatabase(reopenedEmpty)))).val()).toBeNull();
    expect(heldDatabaseInstances(reopenedEmpty)).toEqual([]);
    reopenedEmpty.dispose();

    // Legacy v2 plain-tree migration with arrays and nested objects
    const legacyV2 = JSON.stringify({
      version: 2,
      savedAt: 500,
      firestore: { 'docs/v2': { migrated: true } },
      services: {
        rtdb: {
          items: ['first', 'second'],
          orgs: { o1: { name: 'Acme' } },
        },
      },
    });
    const migratedFromBundle = decodeImportBundle(legacyV2);
    expect(migratedFromBundle.firestore).toEqual({ 'docs/v2': { migrated: true } });

    const rawStore = new Map<string, unknown>([['legacy', legacyV2]]);
    const v2Backend: PersistenceBackend = {
      async getRecord(_k, id) { return rawStore.get(id) ?? null; },
      async listRecords() { return [...rawStore.keys()]; },
      async putRecords(_k, recs) { for (const [id, v] of recs) rawStore.set(id, v); },
      async deleteRecords(_k, ids) { for (const id of ids) rawStore.delete(id); },
      async clear() { rawStore.clear(); },
    };
    const migratedSb = initializeSandbox();
    try {
      await migratedSb.enablePersistence({ key: 'v2', injectedBackend: v2Backend, flushIntervalMs: 60_000 });
      expect(rawStore.has('legacy')).toBe(false);
      const db = getAdminDatabase(migratedSb);
      expect((await get(ref(db, 'items/0'))).val()).toBe('first');
      await set(ref(db, 'items/1'), 'updated');
      expect((await get(ref(db, 'items'))).val()).toEqual(['first', 'updated']);
      expect((await get(ref(db, 'orgs/o1/name'))).val()).toBe('Acme');
    } finally {
      migratedSb.dispose();
    }

    // Validator standing checks: rules-only presence + invalid RTDB rules & corrupt checkpoint rejection
    const rulesOnlyEnvelope = {
      '.pyricRtdbPersistence': 1 as const,
      data: {},
      priorities: {},
      rules: RULES_ONLY_INSTANCE_RULES,
    };
    expect(persistedServiceHasData('rtdb', rulesOnlyEnvelope)).toBe(true);
    expect(() => validatePersistedService('rtdb', rulesOnlyEnvelope)).not.toThrow();

    const parsedV4 = deserializeFromBuckets(parseBundle(bundleRecords(new Map([
      ['meta', { version: 4, savedAt: 1, services: {} }],
      ['rtdb:i:(default)', { version: 1, instance: '(default)', priorities: {}, rules: RULES_ONLY_INSTANCE_RULES }],
    ]))));
    expect(persistedServiceHasData('rtdb', parsedV4.services.rtdb)).toBe(true);

    expect(() =>
      validateRtdbImportRecord('rtdb:i:(default)', {
        version: 1,
        instance: '(default)',
        priorities: {},
        rules: { rules: { '.invalidKey': true } },
      }),
    ).toThrow();

    expect(() =>
      assertCheckpointState({
        firestore: {},
        database: { '.pyricRtdbPersistence': 1, data: {}, priorities: {} },
        storage: [],
        auth: { users: [], providers: {} },
        rules: {
          firestore: '',
          database: { rules: { '.read': 'auth.uid ===' } },
          storage: null,
        },
      }),
    ).toThrow();
  });
});
