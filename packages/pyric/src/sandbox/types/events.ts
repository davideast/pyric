/**
 * The sandbox event surface: every discriminated event variant the
 * sandbox can emit, the shared provenance/service/actor/lens types that
 * ride alongside them, and the {@link SandboxEvent} union itself.
 */

import type { AuthState } from './auth-state.js';

/**
 * Eval-time payload emitted to {@link Sandbox.onDenial} subscribers.
 *
 * Mirrors the structured fields {@link DenialContext} carries (`request`
 * + `resource` + `reasons` + `auth`) so a host environment that wants
 * to surface denials independent of try/catch behavior gets the same
 * frame either way.
 */
export interface DenialEvent {
  code: 'permission-denied';
  message: string;
  auth?: AuthState;
  request?: {
    method: 'get' | 'list' | 'create' | 'update' | 'delete';
    path: string;
    resourceData?: Record<string, unknown>;
  };
  resource?: {
    data: Record<string, unknown> | null;
    exists: boolean;
  };
  reasons?: string[];
}

/**
 * Eval-time payload emitted to {@link Sandbox.onSnapshotError} subscribers.
 *
 * Stream-level error from a Firestore `onSnapshot` listener — the
 * listener has been silently terminated and will deliver no further
 * snapshots (matches production: a stream error is once-per-stream and
 * the listener stays "subscribed" from the consumer's perspective but
 * receives nothing further). Carries the `target` so the host UI can
 * attribute the error to a specific watch.
 *
 * Currently `permission-denied` is the only code the sandbox produces
 * (production also emits `unavailable`, `aborted`, `resource-exhausted`
 * — none of which have a sandbox analog: no network stream to drop, no
 * quota, no concurrent transactions to conflict). Documented divergence
 * from production; new codes can be added if a sandbox-specific
 * scenario surfaces them.
 */
export interface SnapshotErrorEvent {
  code: 'permission-denied';
  message: string;
  target:
    | { kind: 'doc'; path: string }
    | { kind: 'query'; collection: string };
  auth?: AuthState;
  request?: {
    method: 'get' | 'list' | 'create' | 'update' | 'delete';
    path: string;
    resourceData?: Record<string, unknown>;
  };
  resource?: {
    data: Record<string, unknown> | null;
    exists: boolean;
  };
  reasons?: string[];
}

/**
 * Eval-time payload emitted to {@link Sandbox.onRequest} subscribers —
 * one per evaluated op, regardless of outcome.
 *
 * Issue #307: the playground today only renders denials, but every op
 * the simulator evaluates is a request worth seeing. This event is the
 * source of truth; {@link DenialEvent} is a filtered projection over
 * the `result === 'deny'` subset.
 *
 * Origin tells the consumer who initiated the eval:
 *   - `user`        single op via the data-plane adapter (admin / firestore).
 *   - `batch`       part of a multi-op batch — shares `groupId` with siblings.
 *   - `transaction` part of a transaction commit — shares `groupId`.
 *   - `listener`    a write or `deployRules` triggered a snapshot listener
 *                   to re-evaluate. Carries `triggeredBy` naming the
 *                   originating user op (when knowable).
 *
 * `evalMs` measures the wall-clock duration of the simulator's
 * `simulate(...)` call. Sub-millisecond is normal for simple rules;
 * rule-engine-heavy rules (deep boolean chains, many get() calls) can
 * reach tens of milliseconds; a traffic-monitor validation probe measured
 * connect-four rules at ~95ms p99. Surface this in your UI when it matters.
 *
 * Listener throws are swallowed by the dispatcher so a faulty
 * subscriber can't change rule semantics or hide other events.
 *
 * @see traffic-monitor-decision.md for the field-by-field rationale.
 */
export interface RequestEvent {
  /** Discriminator. */
  kind: 'request';
  /** Unique within a sandbox process. Useful for React list keys. */
  id: string;
  /** Wall-clock at op start, ms since epoch. */
  at: number;
  /** Wall-clock duration of the simulator.simulate(...) call, in ms. */
  evalMs: number;
  method: 'get' | 'list' | 'create' | 'update' | 'set' | 'delete';
  path: string;
  auth: AuthState;
  /** `'unsupported'` fires when the simulator hit an unmodelled feature
   *  and the sandbox upgraded it (today: thrown as SimulatorUnsupportedError,
   *  surfaced here as a discrete result so the panel can show it distinctly
   *  from a real denial). */
  result: 'allow' | 'deny' | 'unsupported';
  /** Simulator debug messages — the per-rule trace (`Rule #0 (read) → ALLOW`).
   *  Same shape as `DenialEvent.reasons` so consumer code can share rendering. */
  reasons: string[];
  /** Proposed write payload, for create/update/set. Absent on reads + delete.
   *  Pre-resolution: `FieldValue.*` sentinels are preserved as their marker
   *  shapes (`{ __type: 'serverTimestamp' }`, etc.) so the replay engine
   *  can re-resolve them. The rule engine evaluated against the resolved
   *  form internally; that resolved form lives on
   *  {@link WriteSandboxEvent.nextState}, not here. */
  request?: {
    resourceData?: Record<string, unknown>;
  };
  /** Existing document state before the write (or read target for get). */
  resourceBefore?: {
    data: Record<string, unknown> | null;
    exists: boolean;
  };
  /** Projected document state after the write. Absent on reads. */
  resourceAfter?: {
    data: Record<string, unknown> | null;
    exists: boolean;
  };
  /** Parsed from the simulator's "Rule #N → …" debug line. Absent when no
   *  rule matched (e.g. no allow rules at the path — implicit deny). */
  matchedRule?: { ruleIndex: number; operations: string[] };
  /** The DECIDING rule's verdict + 1-indexed source line + full sub-expression
   *  trace, projected from the simulator's structured `RuleEvaluation`
   *  (additive: present on `result: 'allow' | 'deny'` Firestore events when the
   *  simulator produced a per-rule trace — the allowing rule on an allow, the
   *  denying rule on a deny). Studio's rules inspector reads this to mark the
   *  deciding line and render the evaluation step-through ("show the work").
   *  Absent on an implicit deny (no rule evaluated), a simulator-error deny,
   *  and unsupported results. */
  evaluatedRule?: import('../../rules/test/spec.js').EvaluatedRuleInfo;
  origin: 'user' | 'listener' | 'transaction' | 'batch';
  /** Shared across ops in one batch or transaction. Opaque to consumers. */
  groupId?: string;
  /** Disambiguates `origin: 'transaction' | 'batch'` cases when consumers
   *  need to tell them apart without inspecting `origin` directly. */
  groupKind?: 'batch' | 'transaction';
  /** For listener re-evals: the originating user op that triggered this
   *  re-evaluation. Absent on the initial-snapshot fire. */
  triggeredBy?: { method: string; path: string };
  /** Free-form operation metadata. `admin: true` marks a rules-bypassing
   *  setup/admin operation so fixture tooling can exclude it from protected
   *  behavior while still preserving it as replay context. */
  detail?: { admin?: boolean } & Record<string, unknown>;
}

/**
 * Committed write — a `create`/`update`/`set`/`delete` that the rule
 * engine allowed AND that the keyspace successfully applied. Includes
 * pre- and post-state so consumers can render diffs and (in a future
 * `sandbox.history()` API) reconstruct state by replay.
 *
 * Fires AFTER the corresponding `kind: 'request'` event for the same
 * op. A denied or rolled-back write surfaces as a request-deny only;
 * `write` events only fire for committed writes.
 *
 * `sentinels` and `autoId` are placeholders for the eventual replay
 * engine — v1 of the unified channel leaves them undefined. The shape
 * is locked so consumers can build against it without churn when
 * sentinel/auto-id capture lands.
 */
export interface WriteSandboxEvent {
  kind: 'write';
  id: string;
  at: number;
  method: 'create' | 'update' | 'set' | 'delete';
  path: string;
  auth: AuthState;
  /** Pre-resolution write payload — `FieldValue.*` sentinels preserved
   *  as marker shapes (`{ __type: 'serverTimestamp' }`, etc.) so the
   *  replay engine can re-resolve them. The rule engine evaluated
   *  against the resolved form internally; the resolved form lives on
   *  {@link nextState}. Absent on `delete`. */
  data?: Record<string, unknown>;
  /** State BEFORE this write. `null` for a non-existent doc. */
  priorState: Record<string, unknown> | null;
  /** State AFTER this write. `null` on `delete`. */
  nextState: Record<string, unknown> | null;
  groupId?: string;
  groupKind?: 'batch' | 'transaction';
  /** FieldValue sentinels (serverTimestamp / increment / arrayUnion /
   *  arrayRemove / deleteField → 'delete') extracted from the
   *  pre-resolution write payload. The replay engine consumes this
   *  to re-issue the same sentinels at replay time without consulting
   *  resolved values that would have drifted. Path syntax: dotted
   *  with bracket-indices ('a.b[0].c'). Absent when the write
   *  contained no sentinels. */
  sentinels?: Array<{
    field: string;
    kind: 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete';
  }>;
  /** Minted document ID when this write came from `collection.add()` /
   *  `LocalEnvironment.createWithAutoId`. The replay engine aliases
   *  the path's last segment to a fresh mint on replay (rather than
   *  preserving the original auto-ID). */
  autoId?: string;
  /** Server time at which the rule engine evaluated this write —
   *  pinned per op (or shared across sub-ops in a batch / transaction).
   *  The replay engine re-issues this exact value when re-resolving
   *  `serverTimestamp()` sentinels so resolved fields are bit-identical
   *  on replay. Shape mirrors the Firestore Web SDK Timestamp
   *  (`{ seconds, nanoseconds }`). */
  requestTime: { seconds: number; nanoseconds: number };
  /** Free-form write metadata. `admin: true` marks a rules-bypassing
   *  setup/admin commit so replay can apply it as context without asking
   *  candidate rules to permit it. */
  detail?: { admin?: boolean } & Record<string, unknown>;
}

/**
 * Snapshot delivered to a `onSnapshot` listener's user callback.
 *
 * Fires AFTER the no-op suppression check — every `snapshot_delivery`
 * event corresponds to an actual user-callback invocation. Listener
 * re-evals that resolved to no-ops emit {@link SnapshotSuppressedEvent}
 * instead.
 *
 * `sample` carries best-effort serializable views of the docs the
 * callback received; consumers truncate before persisting if the
 * scenario produces large snapshots.
 */
export interface SnapshotDeliveryEvent {
  kind: 'snapshot_delivery';
  id: string;
  at: number;
  /** Opaque listener id assigned at attach time. */
  listenerId: string;
  target:
    | { kind: 'doc'; path: string }
    | { kind: 'query'; collection: string };
  auth: AuthState;
  addedCount: number;
  modifiedCount: number;
  removedCount: number;
  /** `1` for doc-kind (exists) / `0` (deleted), `n` for query-kind. */
  size: number;
  /** Doc payloads, in the order the user callback saw them. */
  sample?: {
    docs: Array<{ path: string; data: Record<string, unknown> | null }>;
  };
  /** The user op that triggered this re-eval. Absent on initial fire
   *  and on `deployRules`-driven re-evals. */
  triggeredBy?: { method: string; path: string };
}

/**
 * Listener re-eval that was suppressed before delivery — the re-eval
 * ran but produced no observable change vs the prior snapshot, so the
 * user callback wasn't invoked.
 *
 * Useful for "why didn't my listener fire" debugging. Default UIs
 * should filter these out; only the inspector-style consumer needs
 * them.
 */
export interface SnapshotSuppressedEvent {
  kind: 'snapshot_suppressed';
  id: string;
  at: number;
  listenerId: string;
  target:
    | { kind: 'doc'; path: string }
    | { kind: 'query'; collection: string };
  auth: AuthState;
  /** Why this re-eval was suppressed. v1 only emits `'no-op'`. */
  reason: 'no-op';
  triggeredBy?: { method: string; path: string };
}

/**
 * Listener lifecycle event — attach, detach, or errored. Errored
 * supersedes the prior `onSnapshotError` channel; `error` is populated
 * on the errored phase only.
 */
export interface ListenerLifecycleEvent {
  kind: 'listener_attach' | 'listener_detach' | 'listener_errored';
  id: string;
  at: number;
  listenerId: string;
  target:
    | { kind: 'doc'; path: string }
    | { kind: 'query'; collection: string };
  auth: AuthState;
  /** Populated on `listener_errored` only. */
  error?: {
    code: 'permission-denied';
    message: string;
    reasons?: string[];
  };
}

/**
 * Session boundary — emitted before `sandbox.reset()` swaps the env,
 * and before `sandbox.dispose()` tears it down. Lets consumers segment
 * a persisted event stream into "session N pre-reset" / "session N+1
 * post-reset" runs.
 */
export interface SessionBoundaryEvent {
  kind: 'session_boundary';
  id: string;
  at: number;
  phase: 'reset' | 'dispose';
  /** Total events emitted on this sandbox before the boundary. */
  priorOpCount: number;
}

/**
 * Cross-service mutation event — the unified envelope the NON-Firestore
 * services (`auth` / `storage` / `rtdb`) emit into the single
 * `onEvent`/`history()` stream (Pyric Studio keystone, track T1).
 *
 * **Why a new variant rather than reusing `request`/`write`.** Firestore's
 * existing kinds are tightly coupled to the rules-simulator: `RequestEvent`
 * carries `result: 'allow'|'deny'`, `evalMs`, the simulator's `reasons[]`,
 * and `matchedRule`; `WriteSandboxEvent` carries Firestore-specific
 * `sentinels`, `autoId`, and a Firestore `requestTime` Timestamp. Auth user-
 * DB mutations (no path, no rule eval), Storage object puts, and RTDB tree
 * writes don't have those concepts, and bending them into the Firestore
 * shapes would either lie (synthesize a fake `result`/`requestTime`) or
 * pollute the Firestore consumer contract. So this is ONE small, additive
 * variant the three services share — Firestore consumers filter on their
 * existing `kind`s and never see it. See the design rationale.
 *
 * It is intentionally generic: `op` is a free-ish string discriminated by
 * `service`, and `before`/`after` are best-effort serializable snapshots
 * (omitted when not meaningful — e.g. a sign-out has no `after`). Studio's
 * data grids / Action Center render `service` + `op` + `path` directly and
 * diff `before`→`after` when both are present.
 */
export interface ServiceMutationEvent {
  kind: 'service_mutation';
  id: string;
  at: number;
  /**
   * Which service performed the mutation. Always one of the non-Firestore
   * services — Firestore rides its own `request`/`write` path. (The
   * provenance `service` field on the stamped event mirrors this; it is set
   * redundantly here so a consumer matching purely on `kind` still gets the
   * discriminator without reaching into provenance.)
   */
  service: 'auth' | 'storage' | 'rtdb';
  /**
   * Service-scoped operation name. Stable, lowercase, snake/kebab-free:
   *   - auth:    `user_create` | `user_update` | `user_delete` |
   *              `users_clear` | `sign_in` | `sign_out`
   *   - storage: `object_put` | `object_delete` | `metadata_update`
   *   - rtdb:    `set` | `update` | `remove` | `transaction`
   * New ops can be added without a breaking change (consumers switch with a
   * default branch).
   */
  op: string;
  /**
   * The thing mutated, in the service's own addressing scheme:
   *   - auth:    the user `uid` (or `'*'` for a clear-all). Absent for a
   *              sign-out with no prior user.
   *   - storage: the object `fullPath` (e.g. `avatars/alice.png`).
   *   - rtdb:    the database path (e.g. `/rooms/r1/messages`), or for a
   *              multi-path `update` the ref path the call targeted.
   */
  path?: string;
  /** Identity in effect when the op ran (the service's `request.auth`
   *  equivalent). `null` for admin/anonymous-driven mutations (e.g.
   *  `sandbox.createUser`, an unauthenticated RTDB write). */
  auth: AuthState;
  /** Best-effort serializable snapshot of the state BEFORE the mutation.
   *  Absent when there was no prior state (a create) or it isn't cheap to
   *  capture. */
  before?: unknown;
  /** Best-effort serializable snapshot of the state AFTER the mutation.
   *  Absent on deletes / sign-outs (nothing remains). */
  after?: unknown;
  /** Free-form, service-specific extras a consumer may surface without
   *  re-deriving (e.g. storage `{ size, contentType }`, rtdb
   *  `{ committed }` for a transaction). Kept loose on purpose — it's a
   *  display hint, not a contract. */
  detail?: Record<string, unknown>;
}

/**
 * Canonical service operation event. This is the service-neutral successor to
 * Firestore's `request` traffic shape: every user-visible operation can be
 * represented here, whether it is backed by security rules (Firestore/RTDB/
 * Storage) or by a service control plane (Auth).
 *
 * Existing Firestore `request` events remain for compatibility. New cross-
 * service consumers should prefer `operation` because it carries an explicit
 * `service` discriminator and does not require RTDB/Storage/Auth to pretend
 * their state is a Firestore document.
 */
export interface SandboxOperationEvent {
  kind: 'operation';
  id: string;
  at: number;
  service: EventService;
  method: string;
  path?: string;
  auth: AuthState;
  result: 'allow' | 'deny' | 'unsupported' | 'error' | 'not-applicable';
  origin: 'user' | 'listener' | 'transaction' | 'batch' | 'admin' | 'system';
  durationMs?: number;
  reasons?: string[];
  rules?: {
    engine: 'firestore' | 'rtdb' | 'storage';
    matchedPath?: string;
    matchedRule?: string;
    ruleIndex?: number;
    operations?: string[];
    pathVariableBindings?: Record<string, string>;
    reason?: string;
    errorCode?: string;
  };
  request?: {
    data?: unknown;
    resourceData?: unknown;
    query?: unknown;
  };
  resourceBefore?: {
    data: unknown;
    exists: boolean;
  };
  resourceAfter?: {
    data: unknown;
    exists: boolean;
  };
  groupId?: string;
  groupKind?: 'batch' | 'transaction';
  triggeredBy?: { method: string; path?: string };
  detail?: Record<string, unknown>;
}

/**
 * Canonical committed mutation event. Unlike `operation`, this fires only when
 * state actually changed. Replay and branch tooling should eventually consume
 * these service adapters instead of filtering Firestore-only `write` events.
 */
export interface SandboxCommitEvent {
  kind: 'commit';
  id: string;
  at: number;
  service: EventService;
  method: string;
  path?: string;
  auth: AuthState;
  data?: unknown;
  priorState?: unknown;
  nextState?: unknown;
  groupId?: string;
  groupKind?: 'batch' | 'transaction';
  replay?: {
    requestTime?: number;
    autoId?: string;
    sentinels?: Array<{ field: string; kind: string }>;
  };
  detail?: Record<string, unknown>;
}

/**
 * Canonical listener lifecycle/delivery event. Firestore's existing snapshot
 * delivery/lifecycle variants are preserved; this shape gives RTDB and future
 * service listeners the same debuggable surface.
 */
export interface SandboxListenerEvent {
  kind: 'listener';
  id: string;
  at: number;
  service: EventService;
  phase: 'attach' | 'detach' | 'delivery' | 'suppressed' | 'errored';
  listenerId: string;
  target: {
    kind: string;
    path?: string;
    query?: unknown;
  };
  auth: AuthState;
  result?: 'allow' | 'deny' | 'unsupported' | 'error';
  size?: number;
  sample?: unknown;
  reason?: string;
  error?: {
    code?: string;
    message: string;
    reasons?: string[];
  };
  triggeredBy?: { method: string; path?: string };
  detail?: Record<string, unknown>;
}

/** Canonical non-rules operational failure. */
export interface SandboxRuntimeErrorEvent {
  kind: 'runtime_error';
  id: string;
  at: number;
  service: EventService;
  method: string;
  path?: string;
  auth: AuthState;
  error: {
    code?: string;
    message: string;
  };
  detail?: Record<string, unknown>;
}

/**
 * Which sandbox service emitted an event. Today only Firestore emits (events
 * omit `service`, read as `'firestore'`); Pyric Studio's keystone track makes
 * Auth/Storage/RTDB emit into this same stream. See the design rationale.
 */
export type EventService = 'firestore' | 'auth' | 'storage' | 'rtdb';

/** Who initiated the operation behind an event (Studio attributes activity to
 *  the human, the app, or a specific agent). Absent ⇒ the served app. */
export type EventActor =
  | { kind: 'app' }
  | { kind: 'studio' }
  | { kind: 'agent'; name: string }
  | { kind: 'app-builder' };

/**
 * The auth lens an operation ran under: `admin` bypasses rules, `as` evaluates
 * rules as a specific uid (impersonation — the rules-debugging primitive),
 * `app-session` is the app's own signed-in user, and `anon` is a genuinely
 * UNAUTHENTICATED context (`withAuth(null)` — `request.auth == null` in rules).
 * Mirrors the worker's per-op `actAs`. Absent ⇒ `app-session`.
 *
 * `anon` vs absent matters for RELAYED ops (the remote sandbox): an op with no
 * lens resolves to the browser tab's port session — whoever happens to be
 * signed in in the tab. Remote code that means "no auth" must pin
 * `{ mode: 'anon' }` explicitly, or it silently runs as the tab's user.
 */
export type AuthLens =
  | { mode: 'admin' }
  | { mode: 'as'; uid: string; token?: Record<string, unknown> }
  | { mode: 'app-session' }
  | { mode: 'anon' };

/**
 * Provenance carried by every {@link SandboxEvent}. All fields are OPTIONAL and
 * additive: pre-provenance emitters omit them (treated as
 * firestore / app / app-session), so nothing breaks. The Pyric Studio event
 * unification track stamps them at emit across all services, which is what
 * turns the log into "who did what" (Action Center, audit, agent attribution).
 */
export interface EventProvenance {
  service?: EventService;
  actor?: EventActor;
  authLens?: AuthLens;
  /** Set when the op is part of an agent plan (Pyric Agent dry-run / accept). */
  planId?: string;
}

/**
 * Discriminated union of every event the sandbox emits to
 * {@link Sandbox.onEvent} subscribers.
 *
 * Issue #307 — replaces the prior three-channel surface
 * (`onRequest` / `onDenial` / `onSnapshotError`). Filter on `kind`
 * to recover the subset each old channel covered:
 *   - request:        `kind === 'request'`
 *   - denial:         `kind === 'request' && result === 'deny'`
 *   - snapshotError:  `kind === 'listener_errored'`
 *
 * See the design rationale for the
 * field-by-field rationale.
 */
export type SandboxEvent = (
  | RequestEvent
  | WriteSandboxEvent
  | SnapshotDeliveryEvent
  | SnapshotSuppressedEvent
  | ListenerLifecycleEvent
  | SessionBoundaryEvent
  | ServiceMutationEvent
  | SandboxOperationEvent
  | SandboxCommitEvent
  | SandboxListenerEvent
  | SandboxRuntimeErrorEvent
) &
  EventProvenance;
