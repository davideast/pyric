/**
 * The traffic domain types. `TrafficEvent` is structurally identical
 * to `@pyric/sandbox`'s `RequestEvent` (locked in
 * the design rationale) — but the library defines its
 * own copy so it never imports `@pyric/sandbox`. `sandbox.onRequest`
 * is assignable as a `TrafficSource` with zero adapter code; a prod
 * log feed can satisfy the same shape.
 */

export type TrafficMethod =
  | 'get'
  | 'list'
  | 'create'
  | 'update'
  | 'set'
  | 'delete';

export type TrafficResult = 'allow' | 'deny' | 'unsupported';

export type TrafficOrigin = 'user' | 'listener' | 'transaction' | 'batch';

export interface TrafficAuthState {
  uid: string;
  token?: Record<string, unknown>;
}

export interface TrafficResourceState {
  data: Record<string, unknown> | null;
  exists: boolean;
}

export interface TrafficMatchedRule {
  ruleIndex: number;
  operations: string[];
}

export interface TrafficEvent {
  /** Unique per emission. */
  id: string;
  /** `Date.now()` at op start. */
  at: number;
  /** Simulator eval duration in ms. De-featured in the UI (local
   *  simulator) — present for the detail panel only. */
  evalMs: number;
  method: TrafficMethod;
  path: string;
  auth: TrafficAuthState | null;
  result: TrafficResult;
  /** Simulator debug messages — `Rule #N (op) → ALLOW` format. */
  reasons: string[];
  /** Proposed write payload — absent on reads + delete. */
  request?: { resourceData?: Record<string, unknown> };
  /** Existing doc state before the write (or the read target). */
  resourceBefore?: TrafficResourceState;
  /** Projected doc state after the write — absent on reads. */
  resourceAfter?: TrafficResourceState;
  /** Parsed from the matched `Rule #N` debug line — absent if none. */
  matchedRule?: TrafficMatchedRule;
  origin: TrafficOrigin;
  /** Shared across ops in one batch or transaction. */
  groupId?: string;
  /** For listener re-evals — the originating user op. */
  triggeredBy?: { method: string; path: string };
}

/**
 * A subscription function: register a callback, get back an
 * unsubscribe. `@pyric/sandbox`'s `Sandbox.onRequest` matches this
 * signature exactly.
 */
export type TrafficSource = (
  cb: (event: TrafficEvent) => void,
) => () => void;
