/**
 * Public type surface for `@pyric/sandbox`.
 *
 * Kept service-agnostic on purpose: `/app` is the host the rest of the
 * library plugs into. Service modules (`/firestore`, future `/storage`,
 * `/auth`, `/database`) depend on these types; they don't ship from
 * here. See design rationale for the dependency-direction
 * argument.
 */

import type { SandboxPersistenceOptions } from './persistence/types.js';
import type { TabSyncOptions } from './tab-sync/index.js';

/**
 * A signed-in identity for sandbox operations. `null` is anonymous.
 *
 * `token` is the Firebase Auth token claims map (custom claims plus
 * standard ones). It surfaces the same way it does in production rules
 * via `request.auth.token.*`. Omit it for plain UID-only auth.
 *
 * Renamed from `AuthContext` (pre-multi-context) so the data type
 * doesn't visually collide with `SandboxContext` (the identity-bearing
 * handle). They sit at different layers — payload vs. handle — and the
 * names should reflect that.
 */
export type AuthState =
  | { uid: string; token?: Record<string, unknown> }
  | null;

/**
 * Initialization config for a sandbox. All fields are optional; an
 * empty config produces a sandbox with no rules and no seeded data.
 *
 * **No `auth` field.** Identity belongs to {@link SandboxContext}, not
 * the sandbox. Service handles always require an explicit context.
 */
export interface SandboxConfig {
  // Reserved for future service-agnostic config (rules, documents,
  // etc., once the multi-service architecture lands). Empty for now.
}

/**
 * Error codes raised by the sandbox layer.
 *
 * The first batch matches Firebase / gRPC conventions so existing
 * `if (e.code === 'permission-denied')` code from production paths
 * keeps working. The second batch is sandbox-specific and exists so
 * agents can distinguish "sandbox doesn't simulate this" from "your
 * code is wrong" without parsing message strings.
 */
export type SandboxErrorCode =
  // Firebase-aligned
  | 'invalid-argument'
  | 'permission-denied'
  | 'not-found'
  | 'already-exists'
  | 'failed-precondition'
  | 'aborted'
  | 'unavailable'
  // Sandbox-specific
  | 'unimplemented'
  | 'not-seeded'
  | 'rules-not-loaded';

/**
 * Structured denial context emitted alongside a `permission-denied`
 * error. Real Firebase strips this server-side for security; the
 * sandbox can expose it because it's a development tool.
 *
 * `auth` and `reasons` are populated whenever the sandbox raises a
 * `permission-denied` error. `rule` (line + expression) requires
 * source-position tracking in the rules AST and is deferred — see
 * design rationale "Open questions" for the follow-up.
 * `failedFields` will be filled in once the evaluator surfaces field-
 * reference traces.
 */
export interface DenialContext {
  /** The rule whose evaluation produced the denial. Best effort; may be absent until source positions land in the AST. */
  rule?: { line: number; expression: string };
  /** Auth identity that was active when the denial fired. */
  auth?: AuthState;
  /** Field paths in `request.resource.data` that the rule referenced and that failed. */
  failedFields?: string[];
  /**
   * Raw simulator reasoning lines (the underlying engine's
   * `debugMessages`). Always present on `permission-denied`. Stable
   * enough for log surfacing; not stable as machine-parseable data.
   */
  reasons?: string[];
  /**
   * Eval-time request shape — what the rule saw on `request.*`. Lets
   * callers render a "why did this deny" frame (auth, method, path,
   * `request.resource.data` with sentinels resolved) without re-deriving
   * any of it from out-of-band state.
   */
  request?: {
    method: 'get' | 'list' | 'create' | 'update' | 'delete';
    path: string;
    /**
     * The user's proposed `request.resource.data` — pre-resolution.
     * `FieldValue.*` sentinels are preserved as their marker shapes
     * (`{ __type: 'serverTimestamp' }`, etc.). The rule engine
     * evaluated against the resolved form; what surfaces here is the
     * caller's INTENT so consumers see what they tried to write.
     * Absent for reads (no proposed write) and for `delete` (no payload).
     */
    resourceData?: Record<string, unknown>;
  };
  /**
   * Eval-time existing-document snapshot — what the rule saw on
   * `resource.data`. `null` data with `exists: false` mirrors how the
   * rule sees an absent doc. Absent for collection ops (`list`).
   */
  resource?: {
    data: Record<string, unknown> | null;
    exists: boolean;
  };
}

/**
 * Options bag for `SandboxError`. Used by call sites that want to
 * attach actionable remediation text (or both denial context and
 * remediation) without juggling positional argument order.
 */
export interface SandboxErrorOptions {
  code: SandboxErrorCode;
  message: string;
  denialContext?: DenialContext;
  /**
   * Optional human-readable guidance appended to the error's
   * `.message` so existing consumers that surface `error.message`
   * (logs, UIs) see the remediation without an API change. Stored on
   * the instance as well so structured callers can read it directly.
   */
  remediation?: string;
}

/**
 * Sandbox-layer error. Catch with `instanceof SandboxError` and switch
 * on `code`. `denialContext` is populated for `permission-denied` only
 * (and only after Slice 4 wires it through).
 *
 * Two construction forms are supported:
 *   - Positional: `new SandboxError(code, message, denialContext?)` —
 *     the original signature, kept for backward compatibility with
 *     existing internal call sites.
 *   - Options bag: `new SandboxError({ code, message, remediation? })` —
 *     used when attaching remediation guidance.
 */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly denialContext?: DenialContext;
  readonly remediation?: string;

  constructor(code: SandboxErrorCode, message: string, denialContext?: DenialContext);
  constructor(options: SandboxErrorOptions);
  constructor(
    codeOrOptions: SandboxErrorCode | SandboxErrorOptions,
    message?: string,
    denialContext?: DenialContext,
  ) {
    const isOptions = typeof codeOrOptions === 'object';
    const code = isOptions ? codeOrOptions.code : codeOrOptions;
    const baseMessage = isOptions ? codeOrOptions.message : (message as string);
    const ctx = isOptions ? codeOrOptions.denialContext : denialContext;
    const remediation = isOptions ? codeOrOptions.remediation : undefined;
    const fullMessage =
      remediation !== undefined
        ? `${baseMessage}\n\nRemediation:\n${remediation}`
        : baseMessage;
    super(fullMessage);
    this.name = 'SandboxError';
    this.code = code;
    if (ctx !== undefined) {
      this.denialContext = ctx;
    }
    if (remediation !== undefined) {
      this.remediation = remediation;
    }
  }
}

/**
 * Contract for a service that can contribute its state to the sandbox
 * persistence layer. Services (auth, storage, database) register
 * themselves via {@link Sandbox.registerPersistableService} so the
 * sandbox core stays service-agnostic — the sandbox doesn't know what
 * auth or storage look like; it just calls `snapshot()` / `restore()`.
 *
 * `subscribe` is optional but strongly recommended: without it, a
 * service's changes (e.g. new users created via auth) only reach the
 * persisted blob on the next Firestore write. With `subscribe`, the
 * controller debounces a flush on every user-DB change — same latency
 * as Firestore writes.
 */
export interface PersistableService {
  /**
   * Return a plain-JSON-serializable snapshot of this service's state.
   * Called by the persistence controller on every flush. The return
   * value is stored under the service's registered name in the
   * `services` map of the persisted blob.
   */
  snapshot(): unknown;

  /**
   * Restore previously snapshotted state. Called once during
   * `enablePersistence`, AFTER Firestore docs have been restored (so
   * any service that needs Firestore to be hydrated first can rely on
   * that ordering). Guard against bad data — the blob came from disk
   * and may be stale or from a schema migration.
   */
  restore(data: unknown): void;

  /**
   * Optional: subscribe to changes in this service's state. When
   * provided, the persistence controller hooks it up and schedules
   * a debounced flush on each change — ensuring auth-user edits reach
   * the backend promptly, not only on the next Firestore write.
   *
   * Must return an unsubscribe function. The controller unsubscribes
   * on `dispose()`.
   */
  subscribe?: (onChange: () => void) => () => void;

  /**
   * Optional: session-level persistence hooks. When provided, the
   * persistence controller uses these to save and restore the CURRENTLY
   * SIGNED-IN user (not the user database — that's `snapshot`/`restore`).
   *
   * The controller calls `session.subscribe` so it hears every sign-in /
   * sign-out, then writes the uid to the appropriate web-storage slot
   * (determined by `session.mode()`). On init, the controller reads the
   * stored uid and calls `session.restore(uid)` to re-establish the
   * session, firing `onAuthStateChanged` as if the user just signed in.
   *
   * Only active when `SandboxPersistenceOptions.sessionStorage` is
   * provided; omitting `sessionStorage` causes the controller to skip
   * session persistence entirely (no fake durability).
   *
   * Auth is the only service that provides session hooks today. The
   * field is on the generic interface so the controller stays
   * service-agnostic — if a second service ever needs session-style
   * semantics it can add its own hooks without changing the controller.
   */
  session?: {
    /**
     * The uid of the currently signed-in user, or null when signed out.
     * Read by the controller after a subscription fires, and before a
     * save, to snapshot the current state.
     */
    currentUid(): string | null;

    /**
     * Re-establish the signed-in session for `uid`. Fires
     * `onAuthStateChanged` as if the user just signed in. May throw
     * `auth/user-not-found` or `auth/user-disabled` — the controller
     * catches and clears the stored session so a stale uid (user deleted
     * between sessions) doesn't crash init.
     */
    restore(uid: string): void;

    /**
     * Current persistence mode. Determines which web-storage slot the
     * controller writes to:
     *   LOCAL   → localStorage  (survives reload + restart; Firebase default)
     *   SESSION → sessionStorage (survives reload, cleared on tab close)
     *   NONE    → not stored
     *
     * Read on every save so a `setPersistence` call is reflected in the
     * next write without an explicit migration step.
     */
    mode(): 'LOCAL' | 'SESSION' | 'NONE';

    /**
     * Subscribe to sign-in / sign-out changes. The controller installs
     * exactly one subscription here and uses it to drive session saves.
     * Must return an unsubscribe function.
     *
     * Note: this fires on any currentUser change, including external
     * mutations (sandbox.reset(), another handle's sign-in). The
     * controller reads `currentUid()` + `mode()` on each fire and
     * re-computes the correct storage slot — no stale references.
     */
    subscribe(onChange: () => void): () => void;
  };
}

/**
 * Sandbox-level snapshot — a coarse capture of every service's state
 * keyed by service name. The `firestore` key is always present; the
 * `services` map holds one entry per registered persistable service
 * (auth users, future storage objects, etc.). Service-specific
 * snapshot types live in their service modules; `/app` keeps the index
 * structural so it stays decoupled from service implementations.
 *
 * v2 shape — `services` was added when the persistable-service registry
 * landed. Prior `{ firestore }` v1 blobs are treated as having an empty
 * `services` map on restore.
 */
export interface SandboxSnapshot {
  /** Firestore documents, keyed by full path. Always present — empty
   *  `{}` for a fresh or just-reset sandbox. Per-document values are
   *  the post-resolution state the keyspace stored. */
  firestore: Record<string, Record<string, unknown>>;
  /**
   * Per-service opaque state, keyed by service name (e.g. `'auth'`).
   * Each entry is whatever the service's `PersistableService.snapshot()`
   * returned. May be `{}` when no services are registered.
   */
  services: Record<string, unknown>;
}

/**
 * Admin-plane access — bypasses rules, intended for test assertions
 * ("did the write actually land?"). Surfaced only on the root sandbox
 * because admin reads are identity-agnostic and presenting them on a
 * fork (which exists to *carry* an identity) is conceptually muddled.
 *
 * The shape is intentionally flat for v1 since only Firestore exists.
 * When other services land, this surface namespaces by service
 * (`admin.firestore.getDocument`, `admin.storage.getObject`) and the
 * current flat methods will move under `admin.firestore.*`. Document
 * the migration loudly when it happens.
 */
export interface SandboxAdmin {
  /**
   * Read a Firestore document by full path, ignoring rules. Returns
   * `null` if the document doesn't exist.
   */
  getDocument(path: string): unknown | null;

  /**
   * List Firestore documents under a collection path, ignoring rules.
   * Returns `{ path, data, phantom? }` records — `phantom: true` marks
   * synthesized parent docs that have descendants but no stored data
   * of their own (matches what a live Firestore listing would expose).
   */
  listDocuments(prefix: string): { path: string; data: unknown; phantom?: true }[];

  /**
   * Write a Firestore document by full path, ignoring rules. Creates
   * or overwrites the doc — same "replace" semantics as the user-plane
   * `setDoc(ref, data)` (no merge). Intended for admin tools like the
   * playground's Firestore explorer where the operator should be able
   * to seed/edit data regardless of what rules say.
   *
   * Listeners fire as if the write had gone through the rules path,
   * so subscriptions see the change live. Emits a `request` event with
   * `result: 'allow'` and an `auth: null` shape — admin writes leave
   * a trace in the event log, but aren't gated.
   */
  setDocument(path: string, data: Record<string, unknown>): void;

  /**
   * Delete a Firestore document by full path, ignoring rules. Returns
   * `{ deleted }` reflecting whether a doc was actually removed
   * (`false` if the path didn't exist). Idempotent.
   *
   * Same listener / event-log semantics as {@link setDocument}.
   */
  deleteDocument(path: string): { deleted: boolean };
}

/**
 * A Firebase sandbox — an isolated environment with one auth identity.
 *
 * Created via `initializeSandbox(config)`. Use `fork({ auth })` to
 * derive a new sandbox with a different identity that shares the
 * underlying environment (rules, data, state). Fork is the only
 * identity-switching mechanism — there are no per-op auth overrides
 * and no in-place mutation.
 */
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
  origin: 'user' | 'listener' | 'transaction' | 'batch';
  /** Shared across ops in one batch or transaction. Opaque to consumers. */
  groupId?: string;
  /** Disambiguates `origin: 'transaction' | 'batch'` cases when consumers
   *  need to tell them apart without inspecting `origin` directly. */
  groupKind?: 'batch' | 'transaction';
  /** For listener re-evals: the originating user op that triggered this
   *  re-evaluation. Absent on the initial-snapshot fire. */
  triggeredBy?: { method: string; path: string };
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
 * `app-session` is the app's own signed-in user. Mirrors the worker's per-op
 * `actAs`. Absent ⇒ `app-session`.
 */
export type AuthLens =
  | { mode: 'admin' }
  | { mode: 'as'; uid: string }
  | { mode: 'app-session' };

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

export type SandboxEvent = (
  | RequestEvent
  | WriteSandboxEvent
  | SnapshotDeliveryEvent
  | SnapshotSuppressedEvent
  | ListenerLifecycleEvent
  | SessionBoundaryEvent
  | ServiceMutationEvent
) &
  EventProvenance;

/**
 * The data + rules + lifecycle foundation. **Identity-agnostic** —
 * operations through services attached to a `Sandbox` always go via a
 * {@link SandboxContext} that names the auth identity for that
 * operation. Multiple contexts can share one sandbox.
 *
 * Mental model: sandboxes hold the data, contexts carry identity,
 * services attach via factories. See
 * the design rationale for the design rationale.
 */
export interface Sandbox {
  /**
   * Derive a context bound to this sandbox under the given auth
   * identity. Operations through services attached to the returned
   * context evaluate rules under that identity. Many contexts can
   * coexist for one sandbox; data is shared.
   *
   * `null` is anonymous; an `AuthState` object names the user (and
   * optional custom claims). Passing `undefined` is a deliberate
   * error — say `withAuth(null)` for anonymous so the call site is
   * unambiguous.
   *
   * @example
   * ```ts
   * const sandbox = initializeSandbox();
   * const dbAlice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
   * const dbAnon  = getFirestore(sandbox.withAuth(null));
   * ```
   */
  withAuth(auth: AuthState): SandboxContext;

  /**
   * Subscribe to every event the sandbox emits — see {@link SandboxEvent}
   * for the discriminated-union shape. One subscription covers
   * request/denial/snapshot-error/listener-lifecycle/session-boundary;
   * filter on `event.kind` to recover individual streams.
   *
   * Replaces the prior three-channel surface (`onRequest` / `onDenial`
   * / `onSnapshotError`) — see issue #307. Filter cookbook:
   *   - All denials:    `event.kind === 'request' && event.result === 'deny'`
   *   - Stream errors:  `event.kind === 'listener_errored'`
   *   - Per-op traffic: `event.kind === 'request'`
   *
   * Survives `sandbox.reset()` — the subscription is held on the
   * sandbox, not on the underlying environment. A `session_boundary`
   * event with `phase: 'reset'` fires before the env swap so consumers
   * can segment their stream.
   *
   * Returns an unsubscribe function. Listener errors are swallowed so a
   * faulty subscriber can't change rule semantics or hide other events.
   * Both synchronous throws and rejected Promises from async callbacks
   * are silently discarded — subscribers are **observational**, the
   * sandbox doesn't await them and doesn't propagate their errors.
   */
  onEvent(cb: (event: SandboxEvent) => void): () => void;

  /**
   * Every {@link SandboxEvent} this sandbox has emitted since init or
   * the last `reset()`. Returns a defensive copy.
   *
   * Use this for replay: hand the array to `replay(events, rules)`
   * from `@pyric/sandbox` and the engine re-issues every
   * captured write against a fresh sandbox.
   *
   * Unlike {@link onEvent} (live stream from the moment of subscribe),
   * `history()` returns *every* event the sandbox has seen — useful
   * for consumers that attach late (e.g., loading a saved session
   * before subscribing) or that need a snapshot at a particular moment.
   *
   * `reset()` and `dispose()` each append a closing `session_boundary`
   * event; `reset()` then clears the history. Consumers that took a
   * snapshot *before* reset retain the boundary in their copy.
   */
  history(): SandboxEvent[];

  /**
   * Admin-plane access (rule-bypass reads). Identity-agnostic by
   * design — admin reads aren't gated on auth, so they live on the
   * sandbox, not on a context. See {@link SandboxAdmin}.
   */
  readonly admin: SandboxAdmin;

  /**
   * Reset the underlying environment to a fresh state — wipes data,
   * rules, and any service-specific configuration.
   *
   * Snapshot listeners attached to the OLD environment are dropped at
   * the swap — they can't survive because their target docs have been
   * wiped. `onEvent` subscribers DO survive — the registry lives on
   * the sandbox, and a `session_boundary` event with `phase: 'reset'`
   * fires before the swap so subscribers know the rollover happened.
   * Existing {@link SandboxContext}s continue to work — their sandbox
   * reference is stable; subsequent operations resolve to the new env.
   */
  reset(): void;

  /**
   * Tear down listener registries on this sandbox's environment without
   * replacing it. Use this when you're about to discard the sandbox
   * itself (e.g. `runner.reseed()` builds a fresh sandbox rather than
   * calling `reset()`) and want to drop callback references on the
   * outgoing instance defensively. Idempotent. Does not touch data.
   */
  dispose(): void;

  /**
   * Capture a snapshot of every service's state. For v1 with only
   * Firestore, the return value carries a `firestore` key mapping doc
   * paths to data. Future services will add their own keys.
   */
  snapshot(): SandboxSnapshot;

  /**
   * CLOBBER-restore the sandbox's entire state from a prior {@link snapshot}:
   * `reset()` (clears firestore + the signed-in session), then rebuild firestore
   * from `data` and restore each registered service. This is a TOTAL replace —
   * documents absent from `data` do NOT survive — and is the counterpart to
   * {@link snapshot}. It is what makes "transfer (clobber) one instance's data
   * into another" and named-branch switching possible.
   *
   * Fires a `session_boundary` (reset phase), re-evaluates live listeners against
   * the loaded state, and the next persistence flush writes the loaded state.
   * Services present in `data` but not currently registered are skipped (a
   * snapshot taken via {@link snapshot} always includes every registered
   * service, so this only affects cross-instance imports from a sandbox that had
   * a service this one lacks).
   */
  loadSnapshot(data: SandboxSnapshot): void;

  /**
   * Current authenticated user across the sandbox.
   *
   * Mutated by `@pyric/auth`'s `signInAnonymously` /
   * `signInWithEmailAndPassword` / `signOut` / `sandbox.setUser`. Read
   * per-call by service factories (e.g. a future
   * `getFirestore(sandbox)` overload) so they see auth state changes
   * without re-binding handles. Defaults to `null` (anonymous /
   * signed out).
   *
   * **Independent of `withAuth({uid})`** — `withAuth` still produces a
   * frozen {@link SandboxContext} that carries its own identity for
   * the runner's test code (the existing pattern: explicit identity
   * per service call). `currentUser` exists for the `@pyric/auth`
   * mirror, where consumer app code drives identity through a
   * stateful `Auth` handle rather than naming it per call.
   */
  currentUser: AuthState;

  /**
   * Subscribe to `currentUser` changes. Fires on every mutation —
   * sign-in, sign-out, user swap. Does NOT fire on subscribe.
   *
   * Survives `reset()` and `dispose()` only as a no-op: a disposed
   * sandbox emits nothing further; a reset sandbox clears
   * `currentUser` to `null` (and fires the change) before swapping
   * the env.
   *
   * Returns an unsubscribe function. Listener errors are swallowed —
   * subscribers are observational, the sandbox does not propagate
   * their errors.
   */
  onCurrentUserChanged(cb: (user: AuthState) => void): () => void;

  /**
   * Enable cross-tab realtime sync via `BroadcastChannel`. A write in
   * this tab will propagate to every OTHER tab of the same origin that
   * also called `enableTabSync`, causing their `onSnapshot` listeners to
   * re-evaluate — restoring production's cross-client realtime behavior.
   *
   * **Opt-in, OFF by default.** Firestore only (RTDB is a follow-on).
   *
   * Returns a disable function. Calling it removes the `onEvent`
   * subscription, the channel message listener, and closes the channel
   * (when it was created internally). After disable, no further propagation
   * occurs in either direction.
   *
   * **Multi-writer note:** concurrent writes from two tabs to the same doc
   * produce last-write-wins divergence — there is no conflict resolution.
   * The intended model is one active writer (one user, one tab) with
   * observers in other tabs; this covers the overwhelming majority of
   * local development scenarios.
   *
   * @see {@link TabSyncOptions} for channel injection (tests) and originId.
   *
   * @example
   * ```ts
   * // In every tab that should participate in realtime:
   * const sandbox = initializeSandbox();
   * const disableSync = sandbox.enableTabSync();
   * // Later, to stop syncing:
   * disableSync();
   * ```
   */
  enableTabSync(options?: TabSyncOptions): () => void;

  /**
   * Persist the sandbox's data to a backend and restore it on next
   * `enablePersistence` call. The default `'indexedDB'` backend turns
   * the sandbox into the host page's local Firestore — writes flush
   * automatically and a fresh `initializeSandbox()` rehydrates from
   * the prior session.
   *
   * Restoration happens before the promise resolves; awaiting this
   * call is sufficient to guarantee in-memory state matches the
   * persisted blob.
   *
   * Idempotent across the same `key` — calling twice in one process
   * is a no-op on the second call. Different keys are rejected as an
   * error (a sandbox can persist to at most one backend at a time).
   *
   * Listener semantics: every write event the sandbox emits triggers
   * a debounced flush (default 250ms). Browser hosts additionally
   * flush on `beforeunload` so a page navigation doesn't lose the
   * tail of the debounce window.
   *
   * See {@link SandboxPersistenceOptions} for backend selection and
   * tuning.
   */
  enablePersistence(options: SandboxPersistenceOptions): Promise<void>;

  /**
   * Force a snapshot to the configured persistence backend right now.
   * Useful before a manual navigation, or in tests that need
   * deterministic ordering against the debounce window. Resolves once
   * the write hits the backend.
   *
   * Throws if persistence is not enabled.
   */
  flush(): Promise<void>;

  /**
   * Wipe the persisted blob for this sandbox's `key`. In-memory state
   * is left intact — call `reset()` if you want both. Useful for
   * "sign out and forget" flows.
   *
   * No-op when persistence is not enabled.
   */
  clearPersistence(): Promise<void>;

  /**
   * Register a service (auth, storage, …) as a persistence participant.
   * The sandbox calls `hooks.snapshot()` on every flush and
   * `hooks.restore(data)` on restore. If `hooks.subscribe` is provided,
   * the persistence controller subscribes and schedules a debounced
   * flush on each change — so auth-user edits flush promptly, not only
   * on the next Firestore write.
   *
   * Returns an unregister function — call it if the service is torn
   * down before the sandbox is disposed (uncommon in practice; the
   * sandbox's `dispose()` clears the registry anyway).
   *
   * Throws `failed-precondition` when a service with the same `name` is
   * already registered — the auth package registers `'auth'` once when
   * `getAuth(sandbox)` first creates a backend, so accidental double-
   * registration is a caller bug, not a no-op.
   *
   * **Advanced / internal API.** Service packages (auth, storage) call
   * this when they first attach to a sandbox. Consumer app code should
   * not need to call this directly.
   */
  registerPersistableService(name: string, hooks: PersistableService): () => void;
}

/**
 * Identity-bearing handle on a {@link Sandbox}. A `(sandbox, auth)`
 * pair — cheap to create, immutable, freely shareable. Service
 * factories require a `SandboxContext`; bare `Sandbox` is a type
 * error so every call site states identity explicitly.
 *
 * Constructed via `Sandbox.withAuth(auth)` or chained via
 * `SandboxContext.withAuth(auth)`. The concrete class is exported
 * from `@pyric/sandbox` for `instanceof` routing in service
 * factories; consumers don't construct it directly.
 */
export interface SandboxContext {
  /** The data foundation this context operates against. */
  readonly sandbox: Sandbox;
  /** The identity rules evaluate under for operations through this context. */
  readonly auth: AuthState;
  /**
   * Derive a sibling context on the same sandbox with different auth.
   * Replaces, doesn't merge — the new context carries only the new
   * auth, regardless of any prior context's auth.
   */
  withAuth(auth: AuthState): SandboxContext;
}
