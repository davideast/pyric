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

import { getAuth } from '../../auth/instances.js';
import { targetOf } from '../../auth/target.js';
import { getOrCreateBackend } from '../../database/sandbox/backend-for.js';
import type { JsonValue } from '../../database/sandbox/data-tree.js';
import { deleteObject, ref, uploadBytes } from '../../storage/index.js';
import {
  base64ToBytes,
  getAdminStorageSandbox,
  replaceStorageRules,
} from '../../storage/internal.js';
import {
  installsStorageRules,
  type FullSandboxState,
  type SandboxService,
  type StorageObjectState,
} from '../full-state.js';
import { getInternalEnv } from '../internal/sandbox-impl.js';
import type { LocalSandbox } from '../types/service.js';
import {
  AUTH_PROVIDER_CONFIG_PATH,
  DATABASE_PRIORITY_FIELD,
  diffFullStates,
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
    if (document === undefined) {
      target.admin.deleteDocument(path);
      continue;
    }
    target.admin.setDocument(path, structuredClone(document));
  }
}

/** The priority one divergence lands, `null` where the branch carries none. */
function priorityOf(after: unknown): string | number | null {
  if (typeof after === 'string' || typeof after === 'number') return after;
  return null;
}

/**
 * Land the Realtime Database paths the branch changed, and their priorities.
 *
 * The diff already reports each change at the shallowest path that differs,
 * which is exactly the granularity `adminSet` takes, so one record is one
 * write.
 */
function promoteDatabase(target: LocalSandbox, divergences: readonly BranchDivergence[]): void {
  const backend = getOrCreateBackend(target);
  for (const divergence of divergences) {
    if (divergence.field === DATABASE_PRIORITY_FIELD) {
      backend.adminSetPriority(divergence.path, priorityOf(divergence.after));
      continue;
    }
    backend.adminSet(divergence.path, structuredClone(divergence.after) as JsonValue);
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
    await uploadBytes(ref(storage, path), base64ToBytes(object.contentBase64), settableOf(object));
  }
}

/** Land the accounts the branch added, changed, or deleted, and the provider config. */
function promoteAuth(
  target: LocalSandbox,
  next: FullSandboxState,
  divergences: readonly BranchDivergence[],
): void {
  const backend = targetOf(getAuth(target)).backend;
  const accounts = new Map(next.auth.users.map((user) => [user.uid, user]));
  const changed: FullSandboxState['auth']['users'] = [];
  let providersDiverged = false;
  for (const path of divergedPaths(divergences)) {
    if (path === AUTH_PROVIDER_CONFIG_PATH) {
      providersDiverged = true;
      continue;
    }
    const account = accounts.get(path);
    if (account === undefined) {
      backend.deleteUser(path);
      continue;
    }
    changed.push(account);
  }
  if (changed.length > 0) backend.seedUsers(structuredClone(changed));
  if (providersDiverged) backend.restoreProviderConfig({ ...next.auth.providers });
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
  for (const service of divergedPaths(divergences)) {
    if (service === 'firestore') {
      getInternalEnv(target).deployRules(next.rules.firestore);
      continue;
    }
    if (service === 'database') {
      getOrCreateBackend(target).setRules(structuredClone(next.rules.database));
      continue;
    }
    if (!installsStorageRules(next.rules.storage)) continue;
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
  promoteDatabase(target, forService(divergences, 'database'));
  promoteAuth(target, next, forService(divergences, 'auth'));
  await promoteStorage(target, next, forService(divergences, 'storage'));
  await promoteRules(target, next, forService(divergences, 'rules'));
}
