/**
 * Landing a branch on a target, service by service.
 *
 * A promotion is a delta, not a clobber: it computes what the branch changed
 * relative to the state it forked from and writes only that. State on the
 * target that the branch never touched survives, which is what makes promoting
 * onto a live sandbox that moved on since the fork meaningful rather than
 * destructive.
 *
 * The delta is read off the same walk `diff` renders, so a caller who reviewed
 * a diff and then promoted lands exactly the set they reviewed.
 */

import { getAuth } from '../../auth/instances.js';
import { targetOf } from '../../auth/target.js';
import { getOrCreateBackend } from '../../database/sandbox/backend-for.js';
import { deleteObject, ref, uploadBytes } from '../../storage/index.js';
import {
  base64ToBytes,
  getAdminStorageSandbox,
  replaceStorageRules,
} from '../../storage/internal.js';
import type { FullSandboxState, StorageObjectState } from '../full-state.js';
import { getInternalEnv } from '../internal/sandbox-impl.js';
import type { LocalSandbox } from '../types/service.js';
import {
  databasePrioritiesOf,
  databaseTreeOf,
  diffTrees,
  jsonEqual,
} from './state-diff.js';

/** Land the documents the branch added, changed, or deleted. */
function promoteFirestore(target: LocalSandbox, base: FullSandboxState, next: FullSandboxState): void {
  const paths = new Set([...Object.keys(base.firestore), ...Object.keys(next.firestore)]);
  for (const path of paths) {
    const before = base.firestore[path];
    const after = next.firestore[path];
    if (after === undefined) {
      target.admin.deleteDocument(path);
      continue;
    }
    if (jsonEqual(before, after)) continue;
    target.admin.setDocument(path, structuredClone(after));
  }
}

/** Land the Realtime Database paths the branch changed, and their priorities. */
function promoteDatabase(target: LocalSandbox, base: FullSandboxState, next: FullSandboxState): void {
  const backend = getOrCreateBackend(target);
  for (const change of diffTrees(databaseTreeOf(base), databaseTreeOf(next))) {
    backend.adminSet(change.path, structuredClone(change.after));
  }
  const basePriorities = databasePrioritiesOf(base);
  const nextPriorities = databasePrioritiesOf(next);
  const paths = new Set([...Object.keys(basePriorities), ...Object.keys(nextPriorities)]);
  for (const path of paths) {
    if (jsonEqual(basePriorities[path], nextPriorities[path])) continue;
    const priority = nextPriorities[path];
    if (priority === undefined) {
      backend.adminSetPriority(path, null);
      continue;
    }
    backend.adminSetPriority(path, priority as string | number);
  }
}

/** Land the Storage objects the branch added, changed, or removed. */
async function promoteStorage(
  target: LocalSandbox,
  base: FullSandboxState,
  next: FullSandboxState,
): Promise<void> {
  const storage = getAdminStorageSandbox(target);
  const baseObjects = new Map(base.storage.map((object) => [object.path, object]));
  const nextObjects = new Map(next.storage.map((object) => [object.path, object]));
  for (const path of baseObjects.keys()) {
    if (nextObjects.has(path)) continue;
    await deleteObject(ref(storage, path));
  }
  for (const [path, object] of nextObjects) {
    if (jsonEqual(baseObjects.get(path), object)) continue;
    await uploadBytes(ref(storage, path), base64ToBytes(object.contentBase64), settableOf(object));
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

/** Land the accounts the branch added, changed, or deleted, and the provider config. */
function promoteAuth(target: LocalSandbox, base: FullSandboxState, next: FullSandboxState): void {
  const backend = targetOf(getAuth(target)).backend;
  const baseUsers = new Map(base.auth.users.map((user) => [user.uid, user]));
  const nextUsers = new Map(next.auth.users.map((user) => [user.uid, user]));
  for (const uid of baseUsers.keys()) {
    if (nextUsers.has(uid)) continue;
    backend.deleteUser(uid);
  }
  const changed = [...nextUsers.values()].filter(
    (user) => !jsonEqual(baseUsers.get(user.uid), user),
  );
  if (changed.length > 0) backend.seedUsers(structuredClone(changed));
  if (jsonEqual(base.auth.providers, next.auth.providers)) return;
  backend.restoreProviderConfig({ ...next.auth.providers });
}

/** Land whichever of the three rule sources the branch changed. */
async function promoteRules(
  target: LocalSandbox,
  base: FullSandboxState,
  next: FullSandboxState,
): Promise<void> {
  if (base.rules.firestore !== next.rules.firestore) {
    getInternalEnv(target).deployRules(next.rules.firestore);
  }
  if (!jsonEqual(base.rules.database, next.rules.database)) {
    getOrCreateBackend(target).setRules(structuredClone(next.rules.database));
  }
  const storageChanged = base.rules.storage !== next.rules.storage;
  const storageInstallable = next.rules.storage !== null;
  if (storageChanged && storageInstallable) {
    await replaceStorageRules(target, next.rules.storage as string);
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
  promoteFirestore(target, base, next);
  promoteDatabase(target, base, next);
  promoteAuth(target, base, next);
  await promoteStorage(target, base, next);
  await promoteRules(target, base, next);
}
