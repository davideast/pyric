/**
 * Admin-SDK-compat Firestore wrapper for `LocalEnvironment`.
 *
 * Lets agent code written against the firebase-admin Firestore surface
 * run unchanged against the SDK's local simulator. Design rationale +
 * locked divergences live in the design rationale;
 * implementation slicing in the design rationale.
 *
 * Slice 1: shipped public types + a stub `createCompatFirestore`.
 * Slice 2 (this commit): real `FirestoreImpl` with path-shape validation
 * on `collection`/`doc`. The collection/doc/batch/runTransaction bodies
 * still throw `'unimplemented'` until slices 3 + 4 land — but the class
 * shape is final and the path-validation errors users hit first are
 * already typed correctly (`invalid-argument`, not `unimplemented`).
 */

import type { LocalEnvironment } from 'pyric/sandbox/internal';
import type { EventProvenance } from '../../../sandbox/types/events.js';
import { FirestoreImpl } from './firestore.js';
import {
  type AuthContext,
  type Firestore,
} from './types.js';

export {
  FirestoreCompatError,
  FieldValue,
  Timestamp,
} from './types.js';

export type {
  AggregateField,
  AggregateQuerySnapshot,
  AggregateSpec,
  Filter,
  AuthContext,
  CollectionReference,
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  FieldValueSentinel,
  Firestore,
  FirestoreErrorCode,
  FirestoreEvalRequest,
  FirestoreEvalResource,
  FirestoreSimError,
  OperationOptions,
  OrderDirection,
  Query,
  QueryDocumentSnapshot,
  QuerySnapshot,
  SetOptions,
  Transaction,
  WhereFilterOp,
  WriteBatch,
} from './types.js';

export interface CreateCompatFirestoreOptions {
  /**
   * Default auth context applied to every operation. Per-op overrides
   * land in slice 3 (constructor-default + per-op override pattern from
   * divergence #6).
   */
  auth?: AuthContext;
  /**
   * Studio admin lens (Pyric Studio Gap #2). When `true`, the returned
   * handle's operations BYPASS security rules — every read/write is
   * treated as ALLOW (the modular-shaped equivalent of `sandbox.admin.*`).
   * Storage preconditions and the event/listener path are unchanged; only
   * rule evaluation is skipped. Default `false` → rules enforced under
   * `auth`. Used by `getAdminFirestore` (see `pyric-admin` and
   * `pyric/firestore`).
   */
  bypassRules?: boolean;
  /** Adapter-bound operation identity. Internal constructor concern; never a
   * Firebase operation option. */
  provenance?: EventProvenance;
}

/**
 * Construct an Admin-SDK-compat Firestore handle backed by a
 * `LocalEnvironment`. Slice 2 returns a real `FirestoreImpl` with
 * working path-shape validation; the per-method bodies still throw
 * `'unimplemented'` until slices 3 + 4 land.
 */
export function createCompatFirestore(
  env: LocalEnvironment,
  opts?: CreateCompatFirestoreOptions,
): Firestore {
  return new FirestoreImpl(
    env,
    opts?.auth ?? null,
    opts?.bypassRules ?? false,
    opts?.provenance,
  );
}
