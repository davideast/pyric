/**
 * The events/activity domain types. These are a local, structurally-
 * compatible mirror of `pyric`'s unified `SandboxEvent` union (and its
 * `EventProvenance`) — the `@pyric/ui` packages never import `pyric` so
 * the headless layer stays decoupled from the sandbox impl (the same
 * stance the sibling `traffic/` area takes with `RequestEvent`).
 *
 * `sandbox.onEvent` / `sandbox.history()` are assignable as an
 * `ActivitySource` / `ActivityEvent[]` with zero adapter code: every
 * field here is a subset (by name + shape) of the matching field on the
 * sandbox type. A production audit feed satisfying the same shape works
 * too.
 *
 * Unlike `traffic/` (which models only Firestore `request` events, one
 * row per evaluated op), the events area aggregates the FULL stream —
 * Firestore `request`/`write` plus the cross-service `service_mutation`
 * envelope (auth / storage / rtdb) — into category bands. So the local
 * types cover the union members the digest reads, not just one kind.
 */

/** Which sandbox service emitted an event. Absent ⇒ `'firestore'`. */
export type ActivityService = 'firestore' | 'auth' | 'storage' | 'rtdb';

/** Who initiated the op behind an event. Absent ⇒ the served app. */
export type ActivityActor =
  | { kind: 'app' }
  | { kind: 'studio' }
  | { kind: 'agent'; name: string }
  | { kind: 'app-builder' };

/**
 * The auth lens an op ran under. `admin` bypasses rules, `as` evaluates
 * rules as a specific uid (impersonation), `app-session` is the app's
 * own signed-in user. Absent ⇒ `app-session`.
 */
export type ActivityLens =
  | { mode: 'admin' }
  | { mode: 'as'; uid: string }
  | { mode: 'app-session' };

/** Identity in effect for an op. `null` is anonymous / signed out. */
export interface ActivityAuthState {
  uid: string;
  token?: Record<string, unknown>;
}

/**
 * Provenance carried by every event. All optional + additive — pre-
 * provenance emitters omit them (read as firestore / app / app-session).
 */
export interface ActivityProvenance {
  service?: ActivityService;
  actor?: ActivityActor;
  authLens?: ActivityLens;
  /** Set when the op is part of an agent plan (dry-run / accept). */
  planId?: string;
}

/** Firestore op outcome — present on `request` events only. */
export type ActivityResult = 'allow' | 'deny' | 'unsupported';

/**
 * A Firestore `request` event — one per evaluated op. The digest reads
 * these for denials (`result === 'deny'`) and, when no `write` event is
 * present, for the allow trail. Structurally a subset of `RequestEvent`.
 */
export interface ActivityRequestEvent extends ActivityProvenance {
  kind: 'request';
  id: string;
  at: number;
  method: 'get' | 'list' | 'create' | 'update' | 'set' | 'delete';
  path: string;
  auth: ActivityAuthState | null;
  result: ActivityResult;
  /** Simulator debug trail. Used to surface the deciding rule on denials. */
  reasons: string[];
  request?: { resourceData?: Record<string, unknown> };
  resourceBefore?: { data: Record<string, unknown> | null; exists: boolean };
  resourceAfter?: { data: Record<string, unknown> | null; exists: boolean };
  matchedRule?: { ruleIndex: number; operations: string[] };
  origin: 'user' | 'listener' | 'transaction' | 'batch';
  groupId?: string;
  triggeredBy?: { method: string; path: string };
}

/**
 * A committed Firestore write — `create`/`update`/`set`/`delete` that
 * the rule engine allowed and the keyspace applied. The digest leads
 * with these for the added/updated/removed bands (richer than `request`:
 * carries prior/next state for the change summary). Subset of
 * `WriteSandboxEvent`.
 */
export interface ActivityWriteEvent extends ActivityProvenance {
  kind: 'write';
  id: string;
  at: number;
  method: 'create' | 'update' | 'set' | 'delete';
  path: string;
  auth: ActivityAuthState | null;
  data?: Record<string, unknown>;
  priorState: Record<string, unknown> | null;
  nextState: Record<string, unknown> | null;
  groupId?: string;
}

/**
 * Cross-service mutation — the unified envelope auth / storage / rtdb
 * emit. The digest maps `service` + `op` to a band (signed-in, added,
 * updated, removed, …). Subset of `ServiceMutationEvent`.
 */
export interface ActivityServiceMutationEvent extends ActivityProvenance {
  kind: 'service_mutation';
  id: string;
  at: number;
  service: 'auth' | 'storage' | 'rtdb';
  op: string;
  path?: string;
  auth: ActivityAuthState | null;
  before?: unknown;
  after?: unknown;
  detail?: Record<string, unknown>;
}

/**
 * The union members the activity digest aggregates. This is a SUBSET of
 * `pyric`'s `SandboxEvent` — the listener-lifecycle / snapshot-delivery /
 * session-boundary kinds carry no user-visible mutation, so the digest
 * ignores them. The reducer accepts any object with a `kind` and skips
 * the kinds it doesn't model, so a full `SandboxEvent[]` passes through
 * cleanly (the extra kinds fall into the "unknown ⇒ skipped" branch).
 */
export type ActivityEvent =
  | ActivityRequestEvent
  | ActivityWriteEvent
  | ActivityServiceMutationEvent;

/**
 * The widened input the reducer accepts: any `ActivityEvent`, plus a
 * permissive escape for unmodelled `SandboxEvent` kinds carrying a
 * string `kind` (skipped). Lets `sandbox.history()` flow in unfiltered.
 */
export type AnyActivityEvent =
  | ActivityEvent
  | { kind: string; [k: string]: unknown };

/**
 * A subscription: register a callback, get an unsubscribe.
 * `sandbox.onEvent` matches this signature.
 */
export type ActivitySource = (
  cb: (event: AnyActivityEvent) => void,
) => () => void;
