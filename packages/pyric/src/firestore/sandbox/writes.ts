/**
 * Writes / batches / transactions — operation input and result shapes for
 * the Firestore sandbox engine (ADR-0007 mechanical extraction from
 * `local-environment.ts`; re-exported there so the facade surface is
 * unchanged).
 */
import type { DocumentData } from './local-state.js';
import type { AgentEvent } from './event-log.js';
import type { Timestamp } from 'pyric/rules/internal';
import type { FirestoreSimError } from './errors.js';

export interface Operation {
  /**
   * `'set'` is the replace-semantics single-write counterpart of the
   * batch `'set'` op: storage replaces, rule eval translates to
   * `'create'` (doc absent) or `'update'` (doc exists). Use it for
   * `DocumentReference.set(data)` without merge options.
   */
  method: 'get' | 'list' | 'create' | 'update' | 'set' | 'delete';
  path: string;
  auth: { uid: string; token?: Record<string, unknown> } | null;
  data?: DocumentData;
  /** Signals that this `create`'s path-last-segment was minted by
   *  `LocalEnvironment.createWithAutoId` (not user-supplied). The
   *  replay engine reads `WriteSandboxEvent.autoId` and mints a fresh
   *  ID on replay rather than preserving the original. Only meaningful
   *  on `method: 'create'`; ignored otherwise. */
  autoId?: boolean;
  /** Pin the server-time the rule engine sees for this op (replaces
   *  `Timestamp.fromMillis(Date.now())`). Used by the replay engine
   *  with `pinRequestTime: true` so `serverTimestamp()` sentinels
   *  resolve to the captured value and rules that branch on
   *  `request.time` evaluate identically on replay. */
  requestTime?: Timestamp;
  /** FS-B6 — `setDoc(data, {merge})` storage semantics. When set, an
   *  `update`/`create` op DEEP-merges (`merge: true`) or projects to the
   *  listed field paths (`{ mergeFields }`) instead of the shallow
   *  field-path update. Rule evaluation is unaffected (merge still
   *  evaluates as create-when-absent / update-when-present). Only
   *  meaningful when `doc-ref.set` routes a merge write through here. */
  merge?: boolean | { mergeFields: readonly string[] };
  /**
   * Studio admin lens (Pyric Studio Gap #2). When `true`, rule
   * evaluation is SKIPPED for this op — `simulate()` is never called and
   * the op is treated as ALLOW. The write still goes through `applyWrite`
   * (so structural preconditions like create-already-exists / update-
   * missing STILL apply, matching real Firestore admin) and still emits
   * the same `request`/`write` events + wakes listeners. This is the
   * modular-shaped sibling of the path-string `adminSetDocument` /
   * `adminDeleteDocument` bypass — same effect (rules off, store + events
   * on), reachable through the chainable/modular op surface. Default
   * (absent/false) is the unchanged rules-enforced path. */
  bypassRules?: boolean;
}

export interface OperationResult {
  allowed: boolean;
  data?: DocumentData | null;
  debugMessages: string[];
  event: AgentEvent;
  /**
   * Item 6 — typed error code present on every denial / structural
   * failure. Absent when `allowed: true`. See {@link FirestoreSimError}
   * for the canonical code set and {@link makeError} for construction.
   */
  error?: FirestoreSimError;
}

export interface BatchOperationInput {
  method: 'create' | 'update' | 'delete';
  path: string;
  data?: DocumentData;
}

export interface BatchResult {
  allowed: boolean;
  results: {
    path: string;
    allowed: boolean;
    debugMessages: string[];
    /** Item 6 — populated for any per-op denial inside the batch. */
    error?: FirestoreSimError;
  }[];
  event: AgentEvent;
  /**
   * Item 6 — top-level batch error. Set when the batch as a whole was
   * rejected (atomic rollback) — typically the first per-op error, or
   * a sentinel-resolution error that aborted before per-op evaluation.
   */
  error?: FirestoreSimError;
}
