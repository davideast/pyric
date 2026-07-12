/**
 * Sandbox-only type surface for `pyric-admin`'s chainable Firestore
 * adapter — the parts with no production analog.
 */

import type { DocumentData, Firestore } from 'pyric/sandbox/admin-compat';
import type { LintResult } from 'pyric/rules/internal';

/**
 * Returned from `onSnapshot`. Calling it deregisters the listener and
 * stops further callback invocations. Idempotent.
 */
export type Unsubscribe = () => void;

/**
 * Observer form accepted by `onSnapshot`. Mirrors `firebase/firestore`'s
 * `PartialObserver<T>` shape — any subset of the three handlers. `complete`
 * is accepted for shape parity but never fires in the sandbox: the local
 * listener stream has no terminal state.
 */
export interface SnapshotObserver<T> {
  next?: (snapshot: T) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
}

/**
 * Sandbox-extended Firestore handle. Adds three sandbox-only methods
 * on top of the production-shaped {@link Firestore} surface:
 *
 *   - {@link SandboxFirestore.setRules} — replace the active ruleset
 *     for subsequent operations.
 *   - {@link SandboxFirestore.seed} — replace stored documents with a
 *     fresh seed map (rules are preserved).
 *   - {@link SandboxFirestore.snapshot} — capture all stored documents
 *     as a path-keyed map.
 *
 * These have no production analog. They use sandbox vocabulary
 * (`setRules`, `seed`, `snapshot`) deliberately so a reader can't
 * confuse them with Firebase deployment semantics.
 */
export interface SandboxFirestore extends Firestore {
  /**
   * Replace the active ruleset. Returns the lint result so callers can
   * surface warnings; if the source has parse-level errors, the rules
   * are not swapped (consistent with `LocalEnvironment.deployRules`).
   */
  setRules(rules: string): LintResult;

  /**
   * Replace stored documents with a new seed map. Active rules are
   * preserved. Pass an empty `documents` map (or omit it) to clear
   * state without touching rules.
   */
  seed(options?: { documents?: Record<string, DocumentData> }): LintResult;

  /**
   * Capture every stored document as a `{ [path]: data }` map. Reads
   * from the live state and is independent of rules.
   */
  snapshot(): Record<string, DocumentData>;
}
