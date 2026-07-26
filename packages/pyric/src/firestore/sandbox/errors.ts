/**
 * Item 6 — typed error codes for `LocalEnvironment` results.
 *
 * The simulator previously surfaced denials as `allowed: false` plus an
 * unstructured `debugMessages: string[]`. Agents had to grep the string
 * to tell "rule denied" apart from "doc didn't exist" apart from "the
 * sentinel was rejected", which is exactly the affordance Firestore's
 * `FirestoreError.code` gives them in production.
 *
 * The codes here are the canonical set the firebase-admin SDK throws
 * (a subset of gRPC status names). They're string-literal values so
 * downstream consumers can switch on them without importing an enum.
 *
 * Mapping the simulator emits today (Item 6 first cut):
 *   - rule denied                       → 'permission-denied'
 *   - update of missing doc             → 'not-found'
 *   - create of existing doc            → 'already-exists'
 *   - sentinel-resolution failure       → 'invalid-argument'
 *     (admin SDK also throws this for malformed FieldValue use; see
 *      the increment converter's "prior is not numeric" path)
 *
 * Codes defined-but-unused today (`failed-precondition`,
 * `unauthenticated`) are reserved so adding their wiring later is a
 * pure callsite change, no error-set churn.
 */

export const FIRESTORE_ERROR_CODES = [
  'permission-denied',
  'not-found',
  'already-exists',
  'failed-precondition',
  'aborted',
  'invalid-argument',
  'unauthenticated',
  // 'unimplemented' is the gRPC status the real Admin SDK throws for
  // surfaces it doesn't implement. The admin-compat wrapper uses it for
  // (a) slice-1-stub methods that aren't wired yet, and (b) typed-value
  // inputs (GeoPoint/Bytes/Vector/DocumentReference) the simulator
  // doesn't yet accept — both lit up incrementally as parity work lands.
  'unimplemented',
] as const;

export type FirestoreErrorCode = typeof FIRESTORE_ERROR_CODES[number];

/**
 * Eval-time request shape, populated on `permission-denied` so callers
 * can inspect exactly what the rule saw — `request.auth`, the operation
 * method+path, and (for writes) the resolved `request.resource.data`.
 *
 * Sentinels in `resourceData` are resolved (e.g., `serverTimestamp()` →
 * Timestamp), matching what the rule actually evaluated against.
 */
export interface FirestoreEvalRequest {
  method: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: { uid: string; token?: Record<string, unknown> } | null;
  /** `request.resource.data` after sentinel resolution. Absent for reads. */
  resourceData?: Record<string, unknown>;
}

/**
 * Eval-time existing-document state, populated on `permission-denied`
 * for doc operations so callers can see what `resource.data` evaluated
 * to. `null` data with `exists: false` mirrors how Firestore rules see
 * an absent document (resource itself is null).
 */
export interface FirestoreEvalResource {
  data: Record<string, unknown> | null;
  exists: boolean;
}

export interface FirestoreSimError {
  code: FirestoreErrorCode;
  message: string;
  /**
   * Eval-time request shape — populated for `permission-denied` so
   * callers don't have to re-derive `request.auth` / `request.resource`
   * from out-of-band state. Absent for non-denial codes.
   */
  request?: FirestoreEvalRequest;
  /**
   * Eval-time existing doc — populated for `permission-denied` on
   * single-doc operations. Absent for collection ops (`list`) and
   * non-denial codes.
   */
  resource?: FirestoreEvalResource;
  /**
   * Query-side, narrowing-only guidance (RULES-B11) — populated when a
   * `list`/query is denied because it is statically unprovable and the
   * missing/mismatched per-doc equalities suggest a concrete `where(...)`
   * fix. Absent when no actionable suggestion exists (out-of-scope shapes)
   * or for non-query denials.
   */
  remediation?: string;
  /**
   * Machine-readable descriptor of the denied query's where/orderBy/limit
   * shape (RULES-B11) — the structured constraints the engine proved
   * against. Lets consumers render "why did this query deny" without
   * re-deriving the query. Absent for non-query denials.
   */
  query?: QueryDenialDescriptor;
  /**
   * Deciding rule source location and citation (#370).
   */
  rule?: {
    line?: number;
    col?: number;
    column?: number;
    file?: string;
    citation?: string;
    expression?: string;
  };
}

/**
 * The where/orderBy/limit shape of a denied query — structurally the
 * `QueryConstraints` the proof consumed, surfaced on the error so the
 * denial site carries the exact query it rejected.
 */
export interface QueryDenialDescriptor {
  readonly where?: readonly {
    readonly field: string;
    readonly op: string;
    readonly value: string | number | boolean | null;
  }[];
  readonly limit?: number | null;
  readonly offset?: number | null;
  readonly orderBy?: string | null;
}

/**
 * Build a structured error record. The optional `extras` carries
 * eval-time context that downstream layers (admin-compat, sandbox,
 * playground) surface so a denial reads like a debugger frame instead
 * of an opaque "denied by rules".
 */
export function makeError(
  code: FirestoreErrorCode,
  message: string,
  extras?: {
    request?: FirestoreEvalRequest;
    resource?: FirestoreEvalResource;
    remediation?: string;
    query?: QueryDenialDescriptor;
    rule?: {
      line?: number;
      col?: number;
      column?: number;
      file?: string;
      citation?: string;
      expression?: string;
    };
  },
): FirestoreSimError {
  const out: FirestoreSimError = { code, message };
  const hasExtras = extras !== undefined;
  if (hasExtras) {
    const hasRequest = extras!.request !== undefined;
    if (hasRequest) {
      out.request = extras!.request;
    }
    const hasResource = extras!.resource !== undefined;
    if (hasResource) {
      out.resource = extras!.resource;
    }
    const hasRemediation = extras!.remediation !== undefined;
    if (hasRemediation) {
      out.remediation = extras!.remediation;
    }
    const hasQuery = extras!.query !== undefined;
    if (hasQuery) {
      out.query = extras!.query;
    }
    const hasRule = extras!.rule !== undefined;
    if (hasRule) {
      out.rule = extras!.rule;
    }
  }
  return out;
}
