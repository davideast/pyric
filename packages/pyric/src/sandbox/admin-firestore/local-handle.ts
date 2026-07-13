/**
 * Raw local-engine `SandboxFirestore` builder — wraps the
 * `pyric/sandbox/admin-compat` implementation for one `SandboxContext`.
 * Used by both `get-firestore.ts` (rules-enforced) and
 * `get-admin-firestore.ts` (rules-bypassing); the `bypassRules` flag is
 * the only difference between the two callers.
 */

import { createCompatFirestore } from 'pyric/sandbox/admin-compat';
import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  Firestore,
  OperationOptions,
  Query,
  Transaction,
  WriteBatch,
} from 'pyric/sandbox/admin-compat';
import type { LintResult } from 'pyric/rules/internal';
import { isRemoteSandbox, type SandboxContext } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { provenanceForOperationContext } from 'pyric/sandbox/internal';
import type { SandboxFirestore } from './types.js';

/**
 * Build a `SandboxFirestore` that delegates each operation to a freshly
 * constructed compat impl. Constructing the delegate per-call is cheap
 * (no allocation cost beyond the class instance) and ensures the
 * operation reads from whatever environment the sandbox currently
 * exposes — `reset()` propagates without explicit cache invalidation.
 *
 * The handle ignores any per-op `OperationOptions` it receives and
 * always issues operations under `ctx.auth`. To test as a different
 * user, derive a sibling context via `sandbox.withAuth(...)` and
 * attach a service handle to that.
 */
export function buildFirestoreHandle(
  ctx: SandboxContext,
  bypassRules = false,
): SandboxFirestore {
  // Invariant: remote-branded sandboxes are dispatched to the channel-backed
  // arm by getFirestore/getAdminFirestore before this builder runs. Reaching
  // here with a remote ctx means a dispatch bug, not a capability gap.
  if (isRemoteSandbox(ctx.sandbox)) {
    throw new Error(
      'pyric/sandbox/admin-firestore: internal — a remote sandbox context ' +
        'reached the local engine builder; remote dispatch should have ' +
        'handled it. Please report this.',
    );
  }
  const delegate = (): Firestore =>
    createCompatFirestore(getInternalEnv(ctx.sandbox), {
      auth: ctx.auth,
      bypassRules,
      provenance: provenanceForOperationContext(ctx.operationContext),
    });

  return {
    // ── Production-shaped surface ────────────────────────────────────
    collection(path: string): CollectionReference {
      return delegate().collection(path);
    },
    doc(path: string): DocumentReference {
      return delegate().doc(path);
    },
    collectionGroup(collectionId: string): Query {
      return delegate().collectionGroup(collectionId);
    },
    batch(): WriteBatch {
      return delegate().batch();
    },
    runTransaction<R>(
      fn: (tx: Transaction) => Promise<R> | R,
      _opts?: OperationOptions,
    ): Promise<R> {
      return delegate().runTransaction(fn);
    },

    // ── Sandbox-only surface ─────────────────────────────────────────
    setRules(rules: string): LintResult {
      return getInternalEnv(ctx.sandbox).deployRules(rules);
    },
    seed(options?: { documents?: Record<string, DocumentData> }): LintResult {
      const env = getInternalEnv(ctx.sandbox);
      // `LocalEnvironment.seed` rebuilds state and returns the lint of
      // the (preserved) ruleset. Pass the current rules through so
      // `db.seed({ documents })` doesn't accidentally clear them.
      return env.seed({
        rules: env.getRules(),
        documents: options?.documents ?? {},
      });
    },
    snapshot(): Record<string, DocumentData> {
      return getInternalEnv(ctx.sandbox).snapshot();
    },
  };
}
