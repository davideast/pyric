/**
 * `WriteBatchImpl` — Admin-SDK-compat `WriteBatch` backed by
 * `LocalEnvironment.batch(...)`.
 *
 * Ported from bench's `pilot/src/firestore-wrapper.ts:360-391`.
 *
 * Set writes retain replacement intent until commit. The engine selects
 * the create/update rule from the document's state at commit time.
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
import { cloneDoc } from '../document-copy.js';
import {
  FirestoreCompatError,
  type AuthContext,
  type DocumentData,
  type DocumentReference,
  type OperationOptions,
  type SetOptions,
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

  set(ref: DocumentReference, data: DocumentData, options?: SetOptions): WriteBatch {
    const operation: BatchOperationInput = { method: 'set', path: ref.path, data: cloneDoc(data) };
    const mergeFields = options?.mergeFields;
    const hasFieldMask = mergeFields !== undefined;
    if (hasFieldMask) {
      operation.merge = { mergeFields: [...mergeFields] };
    } else {
      const mergesAllFields = options?.merge === true;
      if (mergesAllFields) operation.merge = true;
    }
    this.ops.push(operation);
    return this;
  }

  update(ref: DocumentReference, data: DocumentData): WriteBatch {
    this.ops.push({ method: 'update', path: ref.path, data: cloneDoc(data) });
    return this;
  }

  delete(ref: DocumentReference): WriteBatch {
    this.ops.push({ method: 'delete', path: ref.path });
    return this;
  }

  async commit(opts?: OperationOptions): Promise<void> {
    // Empty batch is a no-op — match Admin SDK behavior (commit() of an
    // empty WriteBatch resolves cleanly without a network round-trip).
    const isEmpty = this.ops.length === 0;
    if (isEmpty) return;
    const authOverride = opts?.auth;
    const hasAuthOverride = authOverride !== undefined;
    const result = this.env.batch(
      this.ops,
      hasAuthOverride ? authOverride : this.auth,
      this.bypassRules,
    );
    const { allowed, error } = result;
    if (allowed) return;
    // Surface the structured error if present (always present per
    // Item 6 — see errors.ts; first per-op error mirrored to top-level).
    const hasError = error !== undefined;
    if (hasError) {
      throw new FirestoreCompatError(error);
    }
    // Defensive fallback — should be unreachable given Item 6's
    // invariant that every denial carries an error.
    const denied = result.results.find((r) => !r.allowed);
    const msg = denied?.debugMessages.join('; ') ?? 'batch denied';
    throw new FirestoreCompatError(makeError('permission-denied', `batch failed: ${msg}`));
  }
}
