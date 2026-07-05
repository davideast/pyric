/**
 * `WriteBatchImpl` — Admin-SDK-compat `WriteBatch` backed by
 * `LocalEnvironment.batch(...)`.
 *
 * Ported from bench's `pilot/src/firestore-wrapper.ts:360-391`.
 *
 * Set semantics: `WriteBatch.set(ref, data)` translates to either
 * `'create'` (doc absent) or `'update'` (doc present) at queue time —
 * the simulator's `BatchOperationInput` accepts only
 * `'create' | 'update' | 'delete'`. The peek runs in the wrapper
 * thread (single-threaded; the simulator is synchronous), so no other
 * write can interleave between peek and queue.
 *
 * Error translation: `LocalEnvironment.batch(...)` returns a
 * `BatchResult` whose `.error` carries a typed `FirestoreSimError`
 * for any failed batch (atomic rollback). Surface that directly as
 * `FirestoreCompatError` — same field-shape as Admin SDK's
 * `FirestoreError.code` so `try { } catch (e) { if (e.code ===
 * 'already-exists') }` works unchanged.
 */

import type { LocalEnvironment } from 'pyric/sandbox/internal';
import type { BatchOperationInput } from 'pyric/sandbox/internal';
import { makeError } from 'pyric/sandbox/internal';
import {
  FirestoreCompatError,
  type AuthContext,
  type DocumentData,
  type DocumentReference,
  type OperationOptions,
  type WriteBatch,
} from './types.js';

export class WriteBatchImpl implements WriteBatch {
  private readonly ops: BatchOperationInput[] = [];

  constructor(
    private readonly env: LocalEnvironment,
    private readonly auth: AuthContext,
    // Studio admin lens (Gap #2) — when true, the committed batch bypasses
    // rules. Forwarded to LocalEnvironment.batch(). Default false.
    private readonly bypassRules: boolean = false,
  ) {}

  set(ref: DocumentReference, data: DocumentData): WriteBatch {
    // Dispatch to create-or-update at queue time — same logic as
    // DocumentRefImpl.set, kept here rather than shared because the
    // batch path has no async wrapping.
    const existing = this.env.getDocument(ref.path);
    const method: 'create' | 'update' = existing === null ? 'create' : 'update';
    this.ops.push({ method, path: ref.path, data });
    return this;
  }

  update(ref: DocumentReference, data: DocumentData): WriteBatch {
    this.ops.push({ method: 'update', path: ref.path, data });
    return this;
  }

  delete(ref: DocumentReference): WriteBatch {
    this.ops.push({ method: 'delete', path: ref.path });
    return this;
  }

  async commit(opts?: OperationOptions): Promise<void> {
    // Empty batch is a no-op — match Admin SDK behavior (commit() of an
    // empty WriteBatch resolves cleanly without a network round-trip).
    if (this.ops.length === 0) return;
    const result = this.env.batch(
      this.ops,
      opts?.auth !== undefined ? opts.auth : this.auth,
      this.bypassRules,
    );
    if (result.allowed) return;
    // Surface the structured error if present (always present per
    // Item 6 — see errors.ts; first per-op error mirrored to top-level).
    if (result.error) {
      throw new FirestoreCompatError(result.error);
    }
    // Defensive fallback — should be unreachable given Item 6's
    // invariant that every denial carries an error.
    const denied = result.results.find((r) => !r.allowed);
    const msg = denied?.debugMessages.join('; ') ?? 'batch denied';
    throw new FirestoreCompatError(makeError('permission-denied', `batch failed: ${msg}`));
  }
}
