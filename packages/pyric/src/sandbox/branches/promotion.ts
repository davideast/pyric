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
  base64ToBytes,
  getAdminStorageSandbox,
  replaceCrossServiceIam,
  replaceStorageRules,
  restoreStorageState,
} from '../../storage/internal.js';
import {
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
 * under the same parent or root survive, and unchanged `.priority` values from
 * `next` are re-applied after `adminSet` writes.
 */
function promoteDatabaseInstance(
  backend: RtdbBackend,
  nextPriorities: Record<string, JsonValue>,
  divergences: readonly BranchDivergence[],
): void {
  if (divergences.length === 0) return;
  const writtenPaths: string[] = [];

  for (const divergence of divergences) {
    if (divergence.field === DATABASE_PRIORITY_FIELD) continue;
    const beforeEmpty =
      divergence.before === null ||
      (isBranchingNode(divergence.before) && Object.keys(divergence.before).length === 0);
    const afterEmptyBranch =
      isBranchingNode(divergence.after) && Object.keys(divergence.after).length === 0;
    const afterDeleted = divergence.after === null || afterEmptyBranch;
    if (afterEmptyBranch && beforeEmpty) continue;
    if (
      afterDeleted &&
      isBranchingNode(divergence.before) &&
      Object.keys(divergence.before).length > 0
    ) {
      deleteLeafEntries(backend, divergence.path, divergence.before);
      continue;
    }
    if (
      beforeEmpty &&
      isBranchingNode(divergence.after) &&
      Object.keys(divergence.after).length > 0
    ) {
      writeLeafEntries(backend, divergence.path, divergence.after, writtenPaths);
      continue;
    }
    backend.adminSet(
      divergence.path,
      afterEmptyBranch ? null : (structuredClone(divergence.after) as JsonValue),
    );
    if (!afterDeleted) writtenPaths.push(divergence.path);
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
    const nextPriorities =
      instance === undefined
        ? databasePrioritiesOf(next)
        : databasePrioritiesOfEnvelope(nextInstances[instance] ?? null);
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

/** Land the Storage objects the branch added, changed, or removed. */
async function promoteStorage(
  target: LocalSandbox,
  next: FullSandboxState,
  divergences: readonly BranchDivergence[],
): Promise<void> {
  const storage = getAdminStorageSandbox(target);
  const objects = new Map(next.storage.map((object) => [object.path, object]));
  for (const path of divergedPaths(divergences)) {
    const object = objects.get(path);
    if (object === undefined) {
      await deleteObject(ref(storage, path));
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
      const providerId = change.field!;
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
 * Land whichever of the three rule sources the branch changed. The diff names
 * each source by its service, so one record is one installation.
 *
 * A branch that ran Storage without rules carries a null source, and
 * {@link installsStorageRules} is the one place that says what that means: no
 * change, because there is no source to install and no way to un-install one.
 * The total replace in `applyFullState` reads the same predicate.
 */
async function promoteRules(
  target: LocalSandbox,
  next: FullSandboxState,
  divergences: readonly BranchDivergence[],
): Promise<void> {
  const seen = new Set<string>();
  for (const divergence of divergences) {
    const key = `${divergence.path}:${divergence.instance ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (divergence.path === 'firestore') {
      getInternalEnv(target).deployRules(next.rules.firestore);
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
    await replaceStorageRules(target, next.rules.storage);
  }
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
  await promoteStorage(target, next, forService(divergences, 'storage'));
  await promoteRules(target, next, forService(divergences, 'rules'));
}
