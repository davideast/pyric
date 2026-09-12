import type { QueryProofDiagnostic } from './query-proof.js';
import type { ServiceMutationEvent } from './service-mutation-event.js';
/**
 * The sandbox event surface: every discriminated event variant the
 * sandbox can emit, the shared provenance/service/actor/lens types that
 * ride alongside them, and the {@link SandboxEvent} union itself.
 */

import type { AuthState } from './auth-state.js';
import type {
  EventProvenance,
  EventService,
  OperationContext,
  RulesDisposition,
} from './operation.js';
export type { MutationEventService, ServiceEventOperation } from './service-event-records.js';
export type {
  ServiceMutationEvent,
  ServiceMutationEventFields,
  ServiceMutationEventOf,
} from './service-mutation-event.js';
export type {
  ServiceEventRecord,
  ServiceEventTarget,
} from './service-event-record.js';
export type {
  ActivityEventProvenance,
  AuthLens,
  EventActor,
  EventProvenance,
  EventService,
  OperationContext,
  RulesDisposition,
} from './operation.js';

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
    | { kind: 'query'; collection: string; query?: unknown };
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
  /** Primary static-proof explanation; evaluatedRule is secondary when present. */
  queryProof?: QueryProofDiagnostic;
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
  /** Local operational outcome. A proof-limited deny does not establish Firebase denial. */
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
  /** For query-proof failures this is the actual residual evaluation, not the
   * primary explanation; consult queryProof. Otherwise, the deciding rule's verdict + 1-indexed source line + full sub-expression
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
  /** Canonical statement of whether Security Rules evaluated this request.
   * Added by the sandbox event recorder when an older emitter omits it. */
  rulesDisposition?: RulesDisposition;
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
 * Who owns a listener: the diagnostic attribution pyric records alongside
 * its own listener events. This is pyric's own surface, not a Firebase one.
 *
 * Three kinds, each answering a different question about the same listener:
 *
 * - `frame`, where the listener was created. The first stack frame outside
 *   pyric's own files at the moment the listener attached: the application
 *   file, line, optional column, and the enclosing function name when the
 *   runtime reported one. Captured once per attach, and only while listener
 *   attribution is enabled, which a production build never is.
 * - `tag`, what the application says owns the listener. Supplied by the
 *   caller through the `owner` listen option, either as a name or as a DOM
 *   element. For an element, `name` is the element's lower-case tag name and
 *   `element` is a selector that identifies it again later.
 * - `regions`, what the delivery changed. The selectors of the elements a
 *   snapshot callback mutated during its own synchronous run. Present only in
 *   a browser, and only on a delivery event.
 * - `component`, the framework component that owns the listener, captured
 *   during render. Unlike `frame`, which reads the call stack at the moment
 *   the listener attaches, `component` reads the render-phase call stack of
 *   the component that will go on to attach it. `@pyric/ui`'s framework
 *   bindings capture this once per component instance and thread it through
 *   the `owner` listen option.
 *
 * One listener can have more than one owner at once: an attach usually
 * carries a frame and, when the caller supplied one, a tag or a component.
 * Events therefore carry `owners` as an array rather than a single field. An
 * event with no attribution omits the array entirely rather than carrying an
 * empty one.
 */
export type ListenerOwner =
  | {
      kind: 'frame';
      /** Path or URL of the application file that created the listener. */
      file: string;
      /** 1-based line number within {@link file}. */
      line: number;
      /** 1-based column, when the runtime's stack format carried one. */
      column?: number;
      /** Enclosing function name, when the runtime's stack format named one. */
      function?: string;
    }
  | {
      kind: 'tag';
      /** Caller-supplied name, or the element's lower-case tag name. */
      name: string;
      /** Selector that re-identifies the element the caller named. */
      element?: string;
    }
  | {
      kind: 'regions';
      /** Selectors of the elements the snapshot callback mutated. */
      selectors: string[];
    }
  | {
      kind: 'component';
      /** The component function's name, read from the render-phase stack. A
       *  minified production build mangles this like any other identifier;
       *  the consuming UI states that rather than guessing at the original
       *  name. */
      name: string;
      /** The chain of enclosing component frames, outermost first, best
       *  effort. Absent when only one component frame was found. */
      path?: string[];
      /** Selector that re-identifies the component's root DOM element, once
       *  the consumer has attached the returned `ref` to it. */
      element?: string;
      /** The root element's tag name, lower case, so a consumer can show the
       *  element as `nav#conversations` when the selector is id-only. */
      tag?: string;
    };

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
  /** Attribution for this delivery: the `regions` owner naming the elements
   *  the callback mutated during its own synchronous run. The `frame` and
   *  `tag` owners live on the matching `listener_attach` event; correlate on
   *  `listenerId` rather than repeating them on every delivery. */
  owners?: ListenerOwner[];
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
    | { kind: 'query'; collection: string; query?: unknown };
  auth: AuthState;
  /** Populated on `listener_errored` only. */
  error?: {
    code: 'permission-denied';
    message: string;
    reasons?: string[];
  };
  /** Attribution recorded on `listener_attach`: the creation `frame` and,
   *  when the caller supplied one, the `tag`. */
  owners?: ListenerOwner[];
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
  /** Canonical statement of whether Security Rules evaluated this operation.
   * Service emitters may provide it directly; the recorder normalizes legacy
   * operation shapes at the unified stream seam. */
  rulesDisposition?: RulesDisposition;
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
  reasons?: string[];
  rules?: SandboxOperationEvent['rules'];
  rulesDisposition?: RulesDisposition;
  /** Attribution for this listener. `attach` carries the creation `frame`
   *  and any caller-supplied `tag`; `delivery` carries the `regions` the
   *  callback mutated. */
  owners?: ListenerOwner[];
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
