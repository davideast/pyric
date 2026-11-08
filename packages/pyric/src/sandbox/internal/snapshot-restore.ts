/**
 * Multi-service `SandboxSnapshot` restoration onto a `LocalSandbox`.
 *
 * Browser-clean (`AGENTS.md` Boundary #5): zero `node:*` imports and zero
 * `Buffer` calls.
 */
import {
  getAuth,
  sandbox as authSandbox,
  type SeedUser,
} from '../../auth/index.js';
import type { RtdbBackend } from '../../database/sandbox/backend.js';
import {
  getOrCreateBackend,
  heldDatabaseInstances,
} from '../../database/sandbox/backend-for.js';
import type { JsonValue } from '../../database/sandbox/data-tree.js';
import { rulesSourceRejection } from '../../rules/internal/index.js';
import {
  rtdbRulesSourceRejection,
  toStrictRulesJson,
} from '../../rules/internal/rtdb.js';
import type { FirebaseStorage } from '../../storage/index.js';
import {
  DEFAULT_BUCKET,
  deployStorageBucketRules,
  getAdminStorageSandbox,
  pruneStorageBucketRules,
  replaceStorageRules,
  resetStorageState,
  seedStorageObject,
  storageBucketsWithRules,
} from '../../storage/internal.js';
import type { LocalSandbox } from '../types/service.js';
import { authAccountsFor } from './auth-accounts.js';
import { databaseInstanceNamed } from './instances.js';
import { getInternalEnv } from './sandbox-impl.js';
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  hasOpenStorage,
  readStorageCaches,
  type RestoreSnapshotOptions,
  type SandboxSnapshot,
  type SnapshotStorageObject,
  type SnapshotUserRecord,
} from './snapshot-codec.js';
import {
  decodeBase64ToBytes,
  decodeSnapshotMapForEnv,
  type EncodedMap,
} from './snapshot-value-codec.js';

function backendForResourceKey(sandbox: LocalSandbox, resourceKey: string): RtdbBackend {
  if (resourceKey === DEFAULT_SNAPSHOT_RESOURCE) {
    return getOrCreateBackend(sandbox);
  }
  return getOrCreateBackend(sandbox, databaseInstanceNamed(resourceKey));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeDocPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function parseRtdbRulesEnvelope(
  text: string,
): { ok: true; rules: { rules: Record<string, unknown> } } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toStrictRulesJson(text));
  } catch (error) {
    const detail = errorMessage(error);
    return { ok: false, reason: `Realtime Database rules are not valid JSON: ${detail}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'Realtime Database rules must be a JSON object with a "rules" key.' };
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    !Object.hasOwn(candidate, 'rules') ||
    candidate.rules === null ||
    typeof candidate.rules !== 'object' ||
    Array.isArray(candidate.rules)
  ) {
    return { ok: false, reason: 'Realtime Database rules must contain a "rules" object.' };
  }
  return { ok: true, rules: { rules: candidate.rules as Record<string, unknown> } };
}

function toSeedUser(user: SnapshotUserRecord): SeedUser {
  const seed: SeedUser = { uid: user.uid };
  if (user.email !== undefined) seed.email = user.email;
  if (user.password !== undefined) seed.password = user.password;
  if (user.displayName !== undefined) seed.displayName = user.displayName;
  if (user.photoUrl !== undefined) seed.photoUrl = user.photoUrl;
  if (user.phoneNumber !== undefined) seed.phoneNumber = user.phoneNumber;
  if (user.emailVerified !== undefined) seed.emailVerified = user.emailVerified;
  if (user.disabled !== undefined) seed.disabled = user.disabled;
  if (user.customClaims !== undefined) {
    seed.customClaims = structuredClone(user.customClaims) as Record<string, unknown>;
  }
  if (user.tenantId !== undefined) seed.tenantId = user.tenantId;
  if (user.providerId !== undefined) seed.providerId = user.providerId;
  if (user.providerUserInfo !== undefined) {
    seed.providerUserInfo = user.providerUserInfo.map((info) => ({ ...info }));
  }
  if (user.createdAt !== undefined) seed.createdAt = user.createdAt;
  if (user.lastLoginAt !== undefined) seed.lastLoginAt = user.lastLoginAt;
  return seed;
}

/** Restore a `SandboxSnapshot` onto `sandbox`, returning any rule load refusals. */
export async function restoreSandboxSnapshot(
  sandbox: LocalSandbox,
  snapshot: SandboxSnapshot,
  options?: RestoreSnapshotOptions,
): Promise<{ refusals: string[] }> {
  const merge = options?.merge === true;
  const refusals: string[] = [];
  const env = getInternalEnv(sandbox);

  const firestoreRulesMap = snapshot.rules.firestore ?? {};
  let defaultFirestoreRules: string | undefined;
  if (Object.hasOwn(firestoreRulesMap, DEFAULT_SNAPSHOT_RESOURCE)) {
    defaultFirestoreRules = firestoreRulesMap[DEFAULT_SNAPSHOT_RESOURCE];
  }
  if (defaultFirestoreRules !== undefined) {
    const rejection = rulesSourceRejection(defaultFirestoreRules);
    if (rejection !== null) {
      refusals.push(`Firestore ${rejection.message}`);
    } else {
      env.deployRules(defaultFirestoreRules);
    }
  } else if (!merge) {
    env.deployRules('');
  }

  const rtdbRulesMap = snapshot.rules.rtdb ?? {};
  if (!merge) {
    const existingKeys = [DEFAULT_SNAPSHOT_RESOURCE, ...heldDatabaseInstances(sandbox)];
    for (const key of existingKeys) {
      if (!Object.hasOwn(rtdbRulesMap, key)) {
        backendForResourceKey(sandbox, key).setRules(null);
      }
    }
  }
  for (const [resourceKey, rawSource] of Object.entries(rtdbRulesMap)) {
    const parsed = parseRtdbRulesEnvelope(rawSource);
    if (!parsed.ok) {
      refusals.push(parsed.reason);
      continue;
    }
    const rejection = rtdbRulesSourceRejection(parsed.rules);
    if (rejection !== null) {
      refusals.push(rejection.message);
      continue;
    }
    backendForResourceKey(sandbox, resourceKey).setRules(parsed.rules);
  }

  const storageRulesMap = snapshot.rules.storage ?? {};
  const hasStorageRules = Object.keys(storageRulesMap).length > 0;
  const hasStorageObjects = Object.values(snapshot.storage).some((items) => items.length > 0);
  const hasDeployedBucketRules = storageBucketsWithRules(sandbox).length > 0;
  const shouldTouchStorage =
    hasStorageRules ||
    hasStorageObjects ||
    hasOpenStorage(sandbox) ||
    hasDeployedBucketRules;

  if (shouldTouchStorage) {
    if (!merge) {
      const keepNamedBuckets = new Set<string>();
      for (const bucketKey of Object.keys(storageRulesMap)) {
        if (bucketKey !== DEFAULT_SNAPSHOT_RESOURCE && bucketKey !== DEFAULT_BUCKET) {
          keepNamedBuckets.add(bucketKey);
        }
      }
      pruneStorageBucketRules(sandbox, keepNamedBuckets);
      const hasDefaultRuleInSnapshot =
        Object.hasOwn(storageRulesMap, DEFAULT_SNAPSHOT_RESOURCE) ||
        Object.hasOwn(storageRulesMap, DEFAULT_BUCKET);
      if (hasOpenStorage(sandbox) && !hasDefaultRuleInSnapshot) {
        await replaceStorageRules(sandbox, null);
      }
    }
    for (const [bucketKey, source] of Object.entries(storageRulesMap)) {
      try {
        if (bucketKey === DEFAULT_SNAPSHOT_RESOURCE || bucketKey === DEFAULT_BUCKET) {
          await replaceStorageRules(sandbox, source);
        } else {
          deployStorageBucketRules(sandbox, bucketKey, source);
        }
      } catch (error) {
        refusals.push(errorMessage(error));
      }
    }
  }

  const auth = getAuth(sandbox);
  if (!merge) {
    authSandbox.clearUsers(auth);
    authAccountsFor(sandbox)?.forgetHistory();
  }
  if (snapshot.auth.users.length > 0) {
    authSandbox.seedUsers(auth, snapshot.auth.users.map(toSeedUser));
  }

  let defaultDocs: Readonly<Record<string, EncodedMap>> = {};
  if (Object.hasOwn(snapshot.firestore, DEFAULT_SNAPSHOT_RESOURCE)) {
    defaultDocs = snapshot.firestore[DEFAULT_SNAPSHOT_RESOURCE] ?? {};
  }
  const normalizedDocs = new Map<string, Record<string, unknown>>();
  for (const [rawPath, encodedData] of Object.entries(defaultDocs)) {
    const cleanPath = normalizeDocPath(rawPath);
    if (cleanPath.length === 0) continue;
    normalizedDocs.set(cleanPath, decodeSnapshotMapForEnv(encodedData));
  }
  if (!merge) {
    for (const existingPath of Object.keys(env.snapshot())) {
      if (!normalizedDocs.has(existingPath)) {
        env.adminDeleteDocument(existingPath);
      }
    }
  }
  for (const [path, decodedData] of normalizedDocs.entries()) {
    env.adminSetDocument(path, decodedData);
  }

  if (!merge) {
    const existingRtdbKeys = [DEFAULT_SNAPSHOT_RESOURCE, ...heldDatabaseInstances(sandbox)];
    for (const key of existingRtdbKeys) {
      if (!Object.hasOwn(snapshot.rtdb, key)) {
        backendForResourceKey(sandbox, key).setData({});
      }
    }
  }
  for (const [resourceKey, tree] of Object.entries(snapshot.rtdb)) {
    const backend = backendForResourceKey(sandbox, resourceKey);
    if (tree === null || tree === undefined) {
      if (!merge) backend.setData({});
      continue;
    }
    const isBranchRecord =
      typeof tree === 'object' &&
      !Array.isArray(tree) &&
      !Object.hasOwn(tree, '.value');
    if (merge && isBranchRecord) {
      const record = tree as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (key === '.priority') continue;
        backend.adminSet(`/${key}`, value as JsonValue);
      }
      if (Object.hasOwn(record, '.priority')) {
        const rootPriority = record['.priority'];
        if (
          typeof rootPriority === 'string' ||
          typeof rootPriority === 'number' ||
          rootPriority === null
        ) {
          backend.adminSetPriority('/', rootPriority);
        }
      }
      continue;
    }
    backend.setData({ '/': tree as JsonValue });
  }

  if (shouldTouchStorage) {
    const caches = readStorageCaches();
    const knownBuckets = new Set<string>(Object.keys(snapshot.storage));
    if (!merge && (hasOpenStorage(sandbox) || hasStorageObjects)) {
      if (hasOpenStorage(sandbox)) {
        knownBuckets.add(DEFAULT_SNAPSHOT_RESOURCE);
      }
      for (const scopedKey of caches?.scopedServices.get(sandbox)?.keys() ?? []) {
        if (scopedKey === DEFAULT_BUCKET) {
          knownBuckets.add(DEFAULT_SNAPSHOT_RESOURCE);
        } else {
          knownBuckets.add(scopedKey);
        }
      }
    }
    for (const bucketKey of knownBuckets) {
      let handle: FirebaseStorage;
      if (bucketKey === DEFAULT_SNAPSHOT_RESOURCE || bucketKey === DEFAULT_BUCKET) {
        handle = getAdminStorageSandbox(sandbox);
      } else {
        handle = getAdminStorageSandbox(sandbox, { bucket: bucketKey });
      }
      if (!merge) {
        await resetStorageState(handle);
      }
      let objects: readonly SnapshotStorageObject[] = [];
      if (Object.hasOwn(snapshot.storage, bucketKey)) {
        objects = snapshot.storage[bucketKey] ?? [];
      }
      for (const item of objects) {
        const bytes = decodeBase64ToBytes(item.contentBase64);
        const metadata: { contentType?: string; customMetadata?: Record<string, string> } = {};
        if (item.contentType !== undefined) metadata.contentType = item.contentType;
        if (item.customMetadata !== undefined) {
          metadata.customMetadata = { ...item.customMetadata };
        }
        await seedStorageObject(handle, item.path, bytes, metadata);
      }
    }
  }

  return { refusals };
}
