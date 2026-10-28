/**
 * Recorded admin writes for `sandbox.admin.setDocument` / `deleteDocument`.
 *
 * `SandboxAdmin`'s contract says an admin write bypasses rules but "leaves a
 * trace in the event log". These run the write through the environment's
 * own rules-bypass path (`bypassRules`, the one `getAdminFirestore` uses), so
 * the write emits the same `request` + `write` events, marked
 * `detail: { admin: true }`. Replay applies such a write without asking the
 * candidate rules, and verify keeps it as context rather than protected
 * behavior (#1058, FS-MET-2 case 3).
 *
 * Restore and replication paths that only move already-recorded state keep
 * calling `LocalEnvironment.adminSetDocument` / `adminDeleteDocument`, which
 * stay quiet.
 */
import type { DocumentData } from './document-store.js';
import { makeError } from './errors.js';
import { FirestoreCompatError } from './firestore-compat-error.js';
import type { LocalEnvironment } from './local-environment.js';
import type { OperationResult } from './writes.js';

/** Replace the document at `path`, rules off, recorded as an admin `set`. */
export function recordedAdminSet(env: LocalEnvironment, path: string, data: DocumentData): void {
  const result = env.execute({ method: 'set', path, data: data ?? {}, auth: null, bypassRules: true });
  if (!result.allowed) throwRefusal(result, path);
}

/**
 * Delete the document at `path`, rules off, recorded as an admin `delete`.
 * Deleting a missing document changes nothing, so it records nothing and
 * reports `{ deleted: false }`.
 */
export function recordedAdminDelete(env: LocalEnvironment, path: string): { deleted: boolean } {
  const isMissing = env.getDocument(path) === null;
  if (isMissing) return { deleted: false };
  const result = env.execute({ method: 'delete', path, auth: null, bypassRules: true });
  if (!result.allowed) throwRefusal(result, path);
  return { deleted: true };
}

function throwRefusal(result: OperationResult, path: string): never {
  const fallback = makeError('failed-precondition', `admin write to '${path}' was not applied: ${result.debugMessages.join('; ')}`);
  throw new FirestoreCompatError(result.error ?? fallback);
}
