/**
 * Item 1.1 — Transaction type surface.
 *
 * Locked decisions live in the design rationale's
 * Decisions Log. Re-stated here only as inline anchors:
 *
 *   - 0.B: `tx.get` of a missing doc returns `{ exists: false, data: () =>
 *     undefined }`. Never throws. Mirrors Admin SDK shape.
 *   - 0.C: `tx.getAll(...paths)` returns snapshots in input order.
 *   - 0.A + 0.J: read-before-write ordering is GLOBAL — any write method
 *     flips a per-tx flag; subsequent reads throw `failed-precondition`.
 *   - 0.D: same-path multi-write merges on commit (last-wins per field).
 *     The merge happens at commit time in `transaction-merge.ts`; the
 *     queue here is append-only.
 *   - 0.G: callback exceptions propagate unchanged. The result types
 *     here only describe the *successful* (or rule-denied) path; thrown
 *     errors don't construct a `TransactionResult`.
 *   - 0.H: no `retries` field. Single-threaded simulator can't trigger
 *     conflicts. Documented as a known limitation.
 */
import type { DocumentData } from './local-state.js';
import type { AgentEvent } from './event-log.js';
import type { FirestoreSimError } from './errors.js';

/**
 * Snapshot shape returned by `tx.get` / `tx.getAll`. Matches the Admin
 * SDK's `DocumentSnapshot` surface narrowly enough for the rules-eval
 * use case — `exists` discriminates and `data()` is lazy because it
 * mirrors the Admin SDK signature even though our impl is eager.
 *
 * Probe 0.B: Admin returns `snap.exists === false` and `snap.data() ===
 * undefined` for a missing doc; never throws. Our shape matches.
 */
export interface TransactionSnapshot {
  readonly path: string;
  readonly exists: boolean;
  data(): DocumentData | undefined;
}

/**
 * Internal — a single read captured during the callback. Surfaced on
 * `TransactionResult.reads` for diagnostic value (production doesn't
 * expose this, but agents debugging "why did my tx commit nothing"
 * benefit from seeing what the callback saw).
 */
export interface CapturedRead {
  path: string;
  data: DocumentData | null;
}

/**
 * Internal — a queued write before merge/commit. Carries the original
 * call method so `transaction-merge.ts` can collapse same-path entries
 * with the right semantics (`update + update` merges; `set + update`
 * applies update on top of set; etc.).
 */
export interface QueuedWrite {
  method: 'set' | 'create' | 'update' | 'delete';
  path: string;
  data?: DocumentData;
}

/**
 * Caller surface for `Transaction`. Implementation lives in
 * `transaction.ts`; this interface is what callbacks see.
 *
 * `set` is included even though `BatchOperationInput` doesn't expose
 * it — the Admin SDK's transaction does, and the merge layer collapses
 * `set` into the appropriate `BatchOperation` at commit.
 */
export interface Transaction {
  /** Admin-mode read; never evaluates rules. */
  get(path: string): TransactionSnapshot;
  /** Admin-mode batched read; preserves input order. */
  getAll(...paths: string[]): TransactionSnapshot[];

  /** Queue a `set` (overwrite-or-create). Flips writeStarted. */
  set(path: string, data: DocumentData): void;
  /** Queue a `create` (fail-on-exists at commit). Flips writeStarted. */
  create(path: string, data: DocumentData): void;
  /** Queue an `update` (fail-if-missing at commit). Flips writeStarted. */
  update(path: string, data: DocumentData): void;
  /** Queue a `delete`. Flips writeStarted. */
  delete(path: string): void;
}

/**
 * Options accepted by `LocalEnvironment.transaction(fn, options)`.
 *
 * `auth` is required (matches `Operation.auth` shape elsewhere in the
 * simulator); rules eval needs it on every queued write.
 *
 * `readOnly` is the side-finding from probe 0.H — Admin's
 * `runTransaction(fn, { readOnly })` accepts it. v1 simulator records
 * a `readOnlyViolation: true` on the result if a write was queued
 * inside a read-only tx, but does NOT throw. Provisional; v2 may flip
 * to strict.
 */
export interface TransactionOptions {
  auth: { uid: string; token?: Record<string, unknown> } | null;
  readOnly?: boolean;
  /**
   * Studio admin lens (Pyric Studio Gap #2). When `true`, per-write rule
   * evaluation at commit is skipped — every queued write is treated as
   * ALLOW. Storage preconditions (create-already-exists, etc.) and the
   * normal commit/event/listener path still apply, so an admin transaction
   * behaves like a rule-allowed one minus the rule gate. Transaction reads
   * (`tx.get`) already bypass rules in the sandbox model, so this flag only
   * affects the write commit. Default (absent/false) enforces rules.
   */
  bypassRules?: boolean;
}

/**
 * Result returned from `LocalEnvironment.transaction(...)` on success
 * or rule-denial. Thrown errors (callback throw, read-after-write
 * violation) do NOT produce a `TransactionResult` — they propagate.
 *
 * `reads` is included for diagnostic value (production doesn't surface
 * this; we do). `writes` is one entry per *queued* write at the time
 * of commit, post-merge — so two `update` calls to the same path
 * produce one `writes[]` entry, not two.
 */
export interface TransactionResult<R = unknown> {
  /** True iff every queued write passed rules and applied. */
  allowed: boolean;
  reads: CapturedRead[];
  writes: {
    path: string;
    method: 'create' | 'update' | 'delete';
    allowed: boolean;
    debugMessages: string[];
    error?: FirestoreSimError;
  }[];
  /** Whatever the callback returned; `undefined` if it returned nothing. */
  returnValue: R | undefined;
  event: AgentEvent;
  /** Top-level error (atomic-rollback case). Absent when `allowed: true`. */
  error?: FirestoreSimError;
  /**
   * Provisional 0.H side-finding: true iff a write method was called
   * inside a `readOnly: true` transaction. v1 still queues + commits
   * the write; v2 may flip to strict (throw at the call site).
   */
  readOnlyViolation?: boolean;
}

/**
 * Locked Admin SDK message for read-after-write violations. Matched
 * exactly so `error.message` parity is preserved for callers that
 * stringify and grep — agents porting tests from prod expect the
 * same wording.
 *
 * Source: probe 0.A run 2026-05-05 against firebase-admin 12.x.
 */
export const READ_AFTER_WRITE_MESSAGE =
  'Firestore transactions require all reads to be executed before all writes.';
