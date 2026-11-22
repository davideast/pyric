/**
 * Landing a branch on a target, service by service.
 *
 * A promotion is a delta, not a clobber: it computes what the branch changed
 * relative to the state it forked from and writes only that. State on the
 * target that the branch never touched survives, which is what makes promoting
 * onto a live sandbox that moved on since the fork meaningful rather than
 * destructive.
 *
 * The delta is the diff. {@link promoteFullState} calls {@link diffFullStates}
 * and writes the records it returns, so "what the diff showed" and "what the
 * promotion landed" are the same set by construction rather than by two
 * comparisons agreeing. Each service reads the records tagged with its own
 * name and turns them into that service's writes.
 */

import { getAuth, sandbox as authSandbox } from '../../auth/index.js';
import { getOrCreateBackend } from '../../database/sandbox/backend-for.js';
import type { RtdbBackend } from '../../database/sandbox/backend.js';
import type { JsonValue } from '../../database/sandbox/data-tree.js';
import { deleteObject, ref, uploadBytes } from '../../storage/index.js';
import {
  DEFAULT_BUCKET,
  base64ToBytes,
  deployStorageBucketRules,
  getAdminStorageSandbox,
  lockUndeployedStorageBuckets,
  pruneStorageBucketRules,
  replaceCrossServiceIam,
  replaceStorageRules,
  restoreStorageState,
  storageBucketsWithRules,
} from '../../storage/internal.js';
import {
  applyMessaging,
  captureMessaging,
  holdsBytesInline,
  type FullSandboxState,
  type SandboxService,
  type StorageObjectState,
} from '../full-state.js';
import { authAccountsFor } from 'pyric/sandbox/internal';
import type { AuthAccountHistory } from '../internal/auth-accounts.js';
import { databaseInstanceNamed } from '../internal/instances.js';
import { getInternalEnv } from '../internal/sandbox-impl.js';
import { decodeStateDocument } from '../internal/state-values.js';
import { normalizeObjectBucket } from '../internal/storage-full-state.js';
import type { LocalSandbox } from '../types/service.js';
import {
  AUTH_DELETIONS_PATH,
  AUTH_PROVIDER_CONFIG_PATH,
  AUTH_REVOCATIONS_PATH,
  DATABASE_PRIORITY_FIELD,
  databaseInstancesOf,
  databasePrioritiesOf,
  databasePrioritiesOfEnvelope,
  diffFullStates,
  isBranchingNode,
  type BranchDivergence,
} from './state-diff.js';

/** The divergences one service reported, in the order the diff walked them. */
function forService(
  divergences: readonly BranchDivergence[],
  service: SandboxService,
): BranchDivergence[] {
  return divergences.filter((divergence) => divergence.service === service);
}

/**
 * The paths one service diverged at, each once. A field-level walk reports
 * several records for one document, object, or account, and every service
 * below writes whole values, so the paths are what it iterates.
 */
function divergedPaths(divergences: readonly BranchDivergence[]): string[] {
  return [...new Set(divergences.map((divergence) => divergence.path))];
}

/** Land the documents the branch added, changed, or deleted. */
function promoteFirestore(
  target: LocalSandbox,
  next: FullSandboxState,
  divergences: readonly BranchDivergence[],
): void {
  for (const path of divergedPaths(divergences)) {
    const document = next.firestore[path];
    const wasDeleted = document === undefined;
    if (wasDeleted) {
      getInternalEnv(target).adminDeleteDocument(path);
      continue;
    }
    getInternalEnv(target).adminSetDocument(path, decodeStateDocument(document, next.firestoreEncoding));
  }
}

/** The priority one divergence lands, `null` where the branch carries none. */
function priorityOf(after: unknown): string | number | null {
  if (typeof after === 'string' || typeof after === 'number') return after;
  return null;
}

function forEachLeafEntry(
  basePath: string,
  value: JsonValue,
  visit: (leafPath: string, leafValue: JsonValue) => void,
): void {
  if (isBranchingNode(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = basePath === '/' || basePath === '' ? key : `${basePath}/${key}`;
      forEachLeafEntry(childPath, child, visit);
    }
    return;
  }
  visit(basePath, value);
}

function writeLeafEntries(
  backend: RtdbBackend,
  basePath: string,
  value: JsonValue,
  writtenPaths: string[],
): void {
  forEachLeafEntry(basePath, value, (leafPath, leafValue) => {
    backend.adminSet(leafPath, structuredClone(leafValue));
    if (leafValue !== null) writtenPaths.push(leafPath);
  });
}

function deleteLeafEntries(backend: RtdbBackend, basePath: string, value: JsonValue): void {
  forEachLeafEntry(basePath, value, (leafPath) => {
    if (backend.adminGet(leafPath) !== null) {
      backend.adminSet(leafPath, null);
    }
  });
}

/**
 * Land the Realtime Database paths the branch changed, and their priorities.
 *
 * When a branch creates or deletes a subtree relative to `base`, each leaf is
 * written or removed individually so concurrent siblings added on `target`
 * under the same parent or root survive. Non-deletion writes run before
 * deletions so replacing all children of an existing prioritized ancestor never
 * transiently empties it and prunes its unchanged `.priority`, and unchanged
 * `.priority` values from `next` are re-applied after `adminSet` writes.
 */
function promoteDatabaseInstance(
  backend: RtdbBackend,
  nextPriorities: Record<string, JsonValue>,
  divergences: readonly BranchDivergence[],
): void {
  if (divergences.length === 0) return;
  const writtenPaths: string[] = [];
  const writes: BranchDivergence[] = [];
  const deletions: BranchDivergence[] = [];

  for (const divergence of divergences) {
    if (divergence.field === DATABASE_PRIORITY_FIELD) continue;
    const beforeEmpty =
      divergence.before === null ||
      (isBranchingNode(divergence.before) && Object.keys(divergence.before).length === 0);
    const afterEmptyBranch =
      isBranchingNode(divergence.after) && Object.keys(divergence.after).length === 0;
    const afterDeleted = divergence.after === null || afterEmptyBranch;
    if (afterEmptyBranch && beforeEmpty) continue;
    if (afterDeleted) {
      deletions.push(divergence);
    } else {
      writes.push(divergence);
    }
  }

  for (const divergence of writes) {
    const beforeEmpty =
      divergence.before === null ||
      (isBranchingNode(divergence.before) && Object.keys(divergence.before).length === 0);
    if (
      beforeEmpty &&
      isBranchingNode(divergence.after) &&
      Object.keys(divergence.after).length > 0
    ) {
      writeLeafEntries(backend, divergence.path, divergence.after, writtenPaths);
      continue;
    }
    backend.adminSet(divergence.path, structuredClone(divergence.after) as JsonValue);
    writtenPaths.push(divergence.path);
  }

  for (const divergence of deletions) {
    if (
      isBranchingNode(divergence.before) &&
      Object.keys(divergence.before).length > 0
    ) {
      deleteLeafEntries(backend, divergence.path, divergence.before);
      continue;
    }
    backend.adminSet(divergence.path, null);
  }

  if (writtenPaths.length > 0) {
    const normalizedWritten = writtenPaths.map((p) => (p === '/' || p === '' ? '/' : p.replace(/^\/+/, '')));
    for (const [priorityPath, rawPriority] of Object.entries(nextPriorities)) {
      const normalizedPriorityPath =
        priorityPath === '/' || priorityPath === '' ? '/' : priorityPath.replace(/^\/+/, '');
      const covered = normalizedWritten.some(
        (written) =>
          written === '/' ||
          normalizedPriorityPath === written ||
          normalizedPriorityPath.startsWith(`${written}/`),
      );
      if (covered) {
        backend.adminSetPriority(priorityPath, priorityOf(rawPriority));
      }
    }
  }

  for (const divergence of divergences) {
    if (divergence.field === DATABASE_PRIORITY_FIELD) {
      backend.adminSetPriority(divergence.path, priorityOf(divergence.after));
    }
  }
}

function promoteDatabase(
  target: LocalSandbox,
  next: FullSandboxState,
  divergences: readonly BranchDivergence[],
): void {
  if (divergences.length === 0) return;
  const byInstance = new Map<string | undefined, BranchDivergence[]>();
  for (const divergence of divergences) {
    let bucket = byInstance.get(divergence.instance);
    if (bucket === undefined) {
      bucket = [];
      byInstance.set(divergence.instance, bucket);
    }
    bucket.push(divergence);
  }
  const nextInstances = databaseInstancesOf(next);
  for (const [instance, slice] of byInstance) {
    const backend = getOrCreateBackend(
      target,
      instance === undefined ? undefined : databaseInstanceNamed(instance),
    );
    let nextPriorities = databasePrioritiesOf(next);
    if (instance !== undefined) {
      nextPriorities = databasePrioritiesOfEnvelope(nextInstances[instance] ?? null);
    }
    promoteDatabaseInstance(backend, nextPriorities, slice);
  }
}

/** The metadata one upload sets, assembled before the call rather than inside it. */
function settableOf(object: StorageObjectState): {
  contentType?: string;
  customMetadata: Record<string, string>;
} {
  const settable: { contentType?: string; customMetadata: Record<string, string> } = {
    customMetadata: { ...object.customMetadata },
  };
  if (object.contentType !== undefined) settable.contentType = object.contentType;
  return settable;
}

function isStorageObjectNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'storage/object-not-found';
}

function handleForStorageBucket(
  target: LocalSandbox,
  bucket: string | undefined,
): ReturnType<typeof getAdminStorageSandbox> {
  if (bucket === undefined) return getAdminStorageSandbox(target);
  return getAdminStorageSandbox(target, { bucket });
}

async function removeTargetStorageObject(
  storage: ReturnType<typeof getAdminStorageSandbox>,
  path: string,
): Promise<void> {
  try {
    await deleteObject(ref(storage, path));
  } catch (error) {
    if (!isStorageObjectNotFound(error)) throw error;
  }
}

/** Land the Storage objects the branch added, changed, or removed across all buckets. */
async function promoteStorage(
  target: LocalSandbox,
  next: FullSandboxState,
  divergences: readonly BranchDivergence[],
): Promise<void> {
  if (divergences.length === 0) return;
  const byBucket = new Map<string | undefined, BranchDivergence[]>();
  for (const divergence of divergences) {
    const bucket = normalizeObjectBucket(divergence.bucket);
    let slice = byBucket.get(bucket);
    if (slice === undefined) {
      slice = [];
      byBucket.set(bucket, slice);
    }
    slice.push(divergence);
  }

  const nextByBucket = new Map<string | undefined, Map<string, StorageObjectState>>();
  for (const object of next.storage) {
    const bucket = normalizeObjectBucket(object.bucket);
    let map = nextByBucket.get(bucket);
    if (map === undefined) {
      map = new Map();
      nextByBucket.set(bucket, map);
    }
    map.set(object.path, object);
  }

  for (const [bucket, slice] of byBucket) {
    const storage = handleForStorageBucket(target, bucket);
    const targetBucket = bucket ?? DEFAULT_BUCKET;
    const objects = nextByBucket.get(bucket) ?? new Map<string, StorageObjectState>();
    for (const path of divergedPaths(slice)) {
      const object = objects.get(path);
      if (object === undefined) {
        await removeTargetStorageObject(storage, path);
        continue;
      }
      // A branch is captured with its bytes inline; a reference names bytes only its own store holds.
      const inline = holdsBytesInline(object);
      if (!inline) throw new Error(`Storage object '${path}' in a branch carries no bytes to promote.`);
      const metadata = object.metadata;
      if (metadata !== undefined) {
        await restoreStorageState(storage, [{
          dataBase64: object.contentBase64,
          blobType: object.blobType ?? object.contentType ?? '',
          metadata: {
            ...metadata,
            bucket: targetBucket,
            fullPath: object.path,
            contentType: object.contentType,
            customMetadata: { ...object.customMetadata },
          },
        }]);
        continue;
      }
      await uploadBytes(ref(storage, path), base64ToBytes(object.contentBase64), settableOf(object));
    }
  }
}

/** Land the accounts the branch added, changed, or deleted, and the provider config. */
function promoteAuth(
  target: LocalSandbox,
  next: FullSandboxState,
  divergences: readonly BranchDivergence[],
): void {
  const auth = getAuth(target);
  const accounts = new Map(next.auth.users.map((user) => [user.uid, user]));
  const changed: FullSandboxState['auth']['users'] = [];
  for (const path of divergedPaths(divergences)) {
    if (path === AUTH_PROVIDER_CONFIG_PATH) continue;
    const isHistory = path === AUTH_REVOCATIONS_PATH || path === AUTH_DELETIONS_PATH;
    if (isHistory) continue;
    const account = accounts.get(path);
    if (account === undefined) {
      authSandbox.deleteUser(auth, path);
      continue;
    }
    changed.push(account);
  }
  if (changed.length > 0) authSandbox.seedUsers(auth, structuredClone(changed));
  const providerChanges = divergences.filter(
    (divergence) => divergence.path === AUTH_PROVIDER_CONFIG_PATH && divergence.field !== undefined,
  );
  if (providerChanges.length > 0) {
    const mergedProviders = { ...authSandbox.exportProviderConfig(auth) };
    for (const change of providerChanges) {
      const providerId = change.field;
      if (providerId === undefined) continue;
      if (typeof change.after === 'boolean') {
        mergedProviders[providerId] = change.after;
      } else {
        delete mergedProviders[providerId];
      }
    }
    authSandbox.restoreProviderConfig(auth, mergedProviders);
  }
  promoteAuthHistory(target, next, divergences);
}

/**
 * Land the revocations and deletions the branch changed, after its accounts:
 * deleting an account on the target records a deletion at the target's now,
 * and the branch's own record of it is the one that lands (#2021).
 */
function promoteAuthHistory(
  target: LocalSandbox,
  next: FullSandboxState,
  divergences: readonly BranchDivergence[],
): void {
  const changes = divergences.filter((divergence) =>
    divergence.path === AUTH_REVOCATIONS_PATH || divergence.path === AUTH_DELETIONS_PATH);
  const table = authAccountsFor(target);
  if (changes.length === 0 || table === undefined) return;
  const landed: AuthAccountHistory = table.history();
  const deleted = new Set(landed.deletedUids);
  const nextTimes = next.auth.history?.tokensValidAfterMs ?? {};
  const nextDeleted = new Set(next.auth.history?.deletedUids ?? []);
  for (const { path, field: uid } of changes) {
    if (uid === undefined) continue;
    if (path === AUTH_DELETIONS_PATH) {
      if (nextDeleted.has(uid)) deleted.add(uid);
      else deleted.delete(uid);
      continue;
    }
    const validAfterMs = nextTimes[uid];
    if (validAfterMs === undefined) delete landed.tokensValidAfterMs[uid];
    else landed.tokensValidAfterMs[uid] = validAfterMs;
  }
  table.replayHistory({ tokensValidAfterMs: landed.tokensValidAfterMs, deletedUids: [...deleted].sort() });
}

/**
 * Land whichever of the rule sources the branch changed, including secondary
 * Realtime Database instances and per-bucket Storage rulesets.
 */
async function promoteRules(
  target: LocalSandbox,
  next: FullSandboxState,
  divergences: readonly BranchDivergence[],
): Promise<void> {
  const seen = new Set<string>();
  for (const divergence of divergences) {
    const key = `${divergence.path}:${divergence.instance ?? ''}:${divergence.bucket ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (divergence.path === 'firestore') {
      const env = getInternalEnv(target);
      if (next.rules.firestore.length > 0) {
        env.deployRules(next.rules.firestore);
      } else {
        env.resetToDefaultRules();
      }
      continue;
    }
    if (divergence.path === 'database') {
      if (divergence.instance !== undefined) {
        getOrCreateBackend(
          target,
          databaseInstanceNamed(divergence.instance),
        ).setRules(structuredClone(next.rules.databaseInstances?.[divergence.instance] ?? null));
      } else {
        getOrCreateBackend(target).setRules(structuredClone(next.rules.database));
      }
      continue;
    }
    if (divergence.path === 'storageCrossServiceIam') {
      await replaceCrossServiceIam(target, next.rules.storageCrossServiceIam ?? 'granted');
      continue;
    }
    if (divergence.path === 'storageUndeployedPolicy') {
      if (next.rules.storageUndeployedPolicy !== undefined) {
        lockUndeployedStorageBuckets(target, next.rules.storageUndeployedPolicy);
      } else if (storageBucketsWithRules(target).length === 0) {
        pruneStorageBucketRules(target, new Set());
      } else {
        lockUndeployedStorageBuckets(target, 'deny');
      }
      continue;
    }
    if (divergence.path === 'storage' && divergence.bucket !== undefined) {
      const nextBucketRules = next.rules.storageBuckets?.[divergence.bucket] ?? null;
      deployStorageBucketRules(target, divergence.bucket, nextBucketRules);
      if (storageBucketsWithRules(target).length === 0 && next.rules.storageUndeployedPolicy === undefined) {
        pruneStorageBucketRules(target, new Set());
      }
      continue;
    }
    await replaceStorageRules(target, next.rules.storage);
  }
}

/** Land the Messaging token records and topic subscription changes the branch made. */
function promoteMessaging(
  target: LocalSandbox,
  next: FullSandboxState,
  divergences: readonly BranchDivergence[],
): void {
  if (divergences.length === 0) return;
  const current = captureMessaging(target);
  const tokenMap = new Map(current?.tokens ?? []);
  const topicMap = new Map<string, Set<string>>();
  for (const [topic, members] of current?.topics ?? []) {
    topicMap.set(topic, new Set(members));
  }
  const nextTokens = new Map(next.messaging?.tokens ?? []);
  const handledTokens = new Set<string>();
  for (const divergence of divergences) {
    if (divergence.path.startsWith('tokens/')) {
      const token = divergence.path.slice('tokens/'.length);
      if (handledTokens.has(token)) continue;
      handledTokens.add(token);
      const nextRecord = nextTokens.get(token);
      if (nextRecord === undefined) tokenMap.delete(token);
      else tokenMap.set(token, structuredClone(nextRecord));
      continue;
    }
    if (divergence.path.startsWith('topics/') && divergence.field !== undefined) {
      const topic = divergence.path.slice('topics/'.length);
      const token = divergence.field;
      let members = topicMap.get(topic);
      if (divergence.after === true) {
        if (members === undefined) {
          members = new Set();
          topicMap.set(topic, members);
        }
        members.add(token);
      } else if (members !== undefined) {
        members.delete(token);
        if (members.size === 0) topicMap.delete(topic);
      }
    }
  }
  applyMessaging(target, {
    version: 1,
    tokens: [...tokenMap],
    topics: [...topicMap].map(([topic, set]) => [topic, [...set]]),
  });
}

/**
 * Write onto `target` everything that differs between the state a branch was
 * forked from and the state it holds now.
 *
 * Not atomic on its own: a write that throws leaves the target part way
 * through. The caller that owns the target's rollback is {@link promote} in
 * `engine.ts`, which captures the target first and restores it on any throw.
 */
export async function promoteFullState(
  target: LocalSandbox,
  base: FullSandboxState,
  next: FullSandboxState,
): Promise<void> {
  const divergences = diffFullStates(base, next);
  promoteFirestore(target, next, forService(divergences, 'firestore'));
  promoteDatabase(target, next, forService(divergences, 'database'));
  promoteAuth(target, next, forService(divergences, 'auth'));
  promoteMessaging(target, next, forService(divergences, 'messaging'));
  await promoteStorage(target, next, forService(divergences, 'storage'));
  await promoteRules(target, next, forService(divergences, 'rules'));
}
