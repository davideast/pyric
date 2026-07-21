/**
 * LocalEnvironment — stateful Firestore sandbox.
 *
 * Wraps LocalState + SimulateFirestoreRulesHandler + EventLog into a
 * complete local development environment. Agents can seed data, deploy
 * rules, execute operations, and undo — all without touching production.
 */
import {
  LocalState,
  type DocStore,
  type DocumentData,
  type BatchOperation,
  type DocEntry,
  type ScanOptions,
} from './local-state.js';
import { OverlayBacking } from './overlay-backing.js';
import { EventLog, type AgentEvent } from './event-log.js';
import { SimulateFirestoreRulesHandler, renderLegacyDebugMessages, projectEvaluatedRule, type EvaluatedRuleInfo } from 'pyric/rules/internal';
import { lintFirestoreRules, type LintResult } from 'pyric/rules/internal';
import type {
  TestCase,
  ListQuery,
  TestResult,
  TestFirestoreRulesResult,
} from 'pyric/rules/internal';
// RULES-B11 — query-proof gate for list reads ("rules are not filters").
import type { QueryConstraints } from './list-query-proof.js';
import {
  resolveValueTree,
  partitionDeletes,
  registerDefaultConverters,
  type ResolveMethod,
} from './value-resolver.js';
import { assertNoNestedDeleteField } from './field-merge.js';
import { Timestamp } from 'pyric/rules/internal';
import { makeError, type FirestoreSimError } from './errors.js';
import { walkForSentinels, type SentinelHit } from './sentinel-capture.js';
import { TransactionContext, type TransactionReader } from './transaction.js';
import { mergeQueuedWrites } from './transaction-merge.js';
import type {
  Transaction,
  TransactionOptions,
  TransactionResult,
} from './transaction-types.js';
import type { EventProvenance } from '../../sandbox/types/events.js';
import type {
  ListenerAuth,
  SnapshotCallback,
  SnapshotErrorCallback,
  SnapshotListenerOptions,
  SnapshotTarget,
} from './snapshot-listeners.js';

// Register every shipped converter exactly once on module load. Idempotent
// per-converter, so re-imports are safe. Item 0 ships an empty registry;
// Items 1+ add converters here.
registerDefaultConverters();





export type {
  Operation,
  OperationResult,
  BatchOperationInput,
  BatchResult,
} from './writes.js';
import type {
  Operation,
  OperationResult,
  BatchOperationInput,
  BatchResult,
} from './writes.js';
import { buildRequestEvent, nextRequestEventId, type EmitRequestInput } from './request-events.js';
export { SimulatorUnsupportedError } from './rules-evaluation.js';
import { FirestoreEventBus } from './event-bus.js';
import { TriggerScope } from './trigger-scope.js';
import { ListenerDispatch } from './listener-dispatch.js';
import { HistoryControls } from './history-controls.js';
import { RulesState } from './rules-state.js';
import { RulesReadEngine } from './rules-read-engine.js';
import { WriteEngine } from './write-engine.js';
import {
  SimulatorUnsupportedError,
  unsupportedMessage,
  isoFromTimestamp,
  DEFAULT_OPEN_RULES,
} from './rules-evaluation.js';







export class LocalEnvironment {
  private state: DocStore;
  private eventLog: EventLog;
  private readonly history: HistoryControls;
  private simulator: SimulateFirestoreRulesHandler;
  /**
   * Deployed rules source + parsed-AST cache (ADR-0009 decision 5).
   * Shared by the rules-gated read paths and the write engine's
   * simulate path; invalidated by `seed` / `deployRules` via `set()`.
   */
  private readonly rules: RulesState;
  private seedSnapshot: Record<string, DocumentData>;
  /**
   * The engine's seven observational event channels — subscriptions and
   * dispatch live in {@link FirestoreEventBus}; payload building stays at
   * the emit* call sites here (lazy allocation + trigger-context access).
   */
  private readonly events = new FirestoreEventBus();

  /**
   * The trigger-attribution baton (ADR-0009 decision 3). Written by the
   * execute / batch / transaction fan-out sites and the scheduled-delivery
   * restore via `run()`'s save/restore stack; read by the listener-origin
   * emit sites via `current()`. See {@link TriggerScope} for semantics.
   */
  private readonly triggerScope = new TriggerScope();

  /**
   * The rules-gated read machinery (ADR-0009, PR B3): silent listener
   * reads + the query-read enforcement path. Also serves as the
   * ListenerDispatchHost.
   */
  private readonly reads: RulesReadEngine;

  /** Rules-aware writes behind the stable LocalEnvironment facade. */
  private readonly writes: WriteEngine;

  /**
   * Snapshot-listener registry + delivery machinery (ADR-0009, PR B2).
   * Rules-gated silent reads arrive through {@link RulesReadEngine},
   * injected as its ListenerDispatchHost.
   */
  private readonly listeners: ListenerDispatch;

  constructor() {
    this.state = new LocalState();
    this.eventLog = new EventLog();
    const engine = this;
    this.simulator = new SimulateFirestoreRulesHandler();
    // Default to an allow-all ruleset so a freshly-constructed sandbox
    // works for the quickstart `addDoc` / `getDoc` flow without forcing
    // the caller to call `setRules(...)` first. The empty string used
    // to live here and made the simulator throw `Failed to parse rules
    // source` on first write — the most common failure mode for new
    // users running `bun start` from `pyric init`. Callers who care
    // about real rule enforcement still call `setRules(...)` explicitly;
    // the default is just "don't blow up before you've thought about
    // rules."
    this.rules = new RulesState(DEFAULT_OPEN_RULES);
    // Rules-gated reads need live keyspace access (`seed()` replaces
    // `state`) and the facade's buildTestCase (shared with the write
    // engine's simulate path) — injected as a narrow RulesReadHost.
    this.reads = new RulesReadEngine(this.events, this.triggerScope, this.rules, this.simulator, {
      get state() { return engine.state; },
      buildTestCase: (operation, serverTime) => this.buildTestCase(operation, serverTime),
    });
    // Listener dispatch calls back into the engine only for rules-gated
    // silent reads — RulesReadEngine IS its ListenerDispatchHost.
    this.listeners = new ListenerDispatch(this.events, this.triggerScope, this.reads);
    this.writes = new WriteEngine(
      { get state() { return engine.state; } },
      this.rules,
      this.simulator,
      this.eventLog,
      this.events,
      this.triggerScope,
      this.listeners,
    );
    // Undo/redo needs live keyspace access (`seed()` replaces `state`) and
    // the write engine's affected-path helpers.
    this.history = new HistoryControls(this.eventLog, {
      get state() { return engine.state; },
      capturePriors: (paths) => this.writes.capturePriors(paths),
      applyWrite: (method, path, data, merge) => this.writes.applyWrite(method, path, data, merge),
    });
    this.seedSnapshot = {};
  }

  /**
   * Subscribe to permission-denied events. Returns an unsubscribe fn.
   * The callback receives the structured `FirestoreSimError` carrying
   * `request` / `resource` (when populated) — so subscribers can render
   * a debugger-style frame without re-deriving any state.
   *
   * Listener throws are swallowed to keep the simulator hot path
   * resilient — a faulty subscriber should not change rule semantics.
   */
  onDenial(cb: (err: FirestoreSimError) => void): () => void {
    return this.events.denial.subscribe(cb);
  }

  private emitDenial(err: FirestoreSimError): void {
    this.events.denial.emit(err);
  }

  /**
   * Subscribe to every evaluated op (issue #307). Returns an unsubscribe
   * fn. The emit sites in `execute`, `batch`, `silentReadDoc`,
   * `silentReadCollection` build the public-shape event lazily — when
   * no subscribers are attached, eval doesn't pay the allocation cost.
   */
  onRequest(cb: (event: import('../../sandbox/types/events.js').RequestEvent) => void): () => void {
    return this.events.request.subscribe(cb);
  }

  /**
   * Subscribe to committed-write events. Internal — bridged to the
   * public `Sandbox.onEvent` channel by SandboxImpl. Fires AFTER the
   * keyspace applies the write; denied / rolled-back writes don't
   * emit here.
   */
  onWrite(cb: (event: import('../../sandbox/types/events.js').WriteSandboxEvent) => void): () => void {
    return this.events.write.subscribe(cb);
  }

  /** Internal — bridge for sandbox-level `onEvent` to receive
   *  snapshot-delivery events. Fires after the user callback runs. */
  onSnapshotDelivery(cb: (event: import('../../sandbox/types/events.js').SnapshotDeliveryEvent) => void): () => void {
    return this.events.delivery.subscribe(cb);
  }

  /** Internal bridge for snapshot_suppressed events — re-evals that
   *  didn't deliver because diffing found no observable change. */
  onSnapshotSuppressed(cb: (event: import('../../sandbox/types/events.js').SnapshotSuppressedEvent) => void): () => void {
    return this.events.suppressed.subscribe(cb);
  }

  /** Internal bridge for listener attach/detach lifecycle. Errored
   *  routes through onSnapshotError separately. */
  onListenerLifecycle(cb: (event: import('../../sandbox/types/events.js').ListenerLifecycleEvent) => void): () => void {
    return this.events.lifecycle.subscribe(cb);
  }

  /**
   * Build and dispatch a `WriteSandboxEvent`. Same sync-throw +
   * async-rejection isolation as emitRequest. Bails early when no
   * subscribers are attached so the hot path stays allocation-free.
   *
   * `sentinels` and `autoId` are reserved fields the caller can
   * populate when the replay-engine work lands. v1 always passes
   * undefined for both.
   */
  private emitWrite(input: {
    method: 'create' | 'update' | 'set' | 'delete';
    path: string;
    auth: Operation['auth'];
    data?: Record<string, unknown>;
    priorState: Record<string, unknown> | null;
    nextState: Record<string, unknown> | null;
    groupId?: string;
    groupKind?: 'batch' | 'transaction';
    /** Sentinels extracted from the *pre-resolution* payload.
     *  Populated by the caller via {@link walkForSentinels}; passed
     *  through to consumers so the replay engine can re-issue the
     *  same FieldValue sentinels at replay time. */
    sentinels?: import('./sentinel-capture.js').SentinelHit[];
    /** Minted auto-id (the path's last segment) when this `create`
     *  came from `createWithAutoId`. The replay engine reads this and
     *  mints a fresh id on replay rather than reusing the original. */
    autoId?: string;
    /** Server-time pin for the rule eval, in Timestamp shape. The
     *  replay engine uses this to re-issue the same Date.now() value
     *  when re-resolving serverTimestamp() sentinels. */
    requestTime: Timestamp;
    detail?: { admin?: boolean } & Record<string, unknown>;
    provenance?: EventProvenance;
  }): void {
    if (!this.events.write.hasSubscribers) return;
    const event: import('../../sandbox/types/events.js').WriteSandboxEvent = {
      kind: 'write',
      id: nextRequestEventId().replace(/^req-/, 'wr-'),
      at: Date.now(),
      method: input.method,
      path: input.path,
      auth: input.auth
        ? { uid: input.auth.uid, ...(input.auth.token ? { token: input.auth.token } : {}) }
        : null,
      ...(input.data !== undefined ? { data: input.data } : {}),
      priorState: input.priorState,
      nextState: input.nextState,
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.groupKind !== undefined ? { groupKind: input.groupKind } : {}),
      ...(input.sentinels && input.sentinels.length > 0 ? { sentinels: input.sentinels } : {}),
      ...(input.autoId !== undefined ? { autoId: input.autoId } : {}),
      requestTime: { seconds: input.requestTime.seconds, nanoseconds: input.requestTime.nanos },
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.provenance ?? {}),
    };
    this.events.write.emit(event);
  }

  /**
   * Build and dispatch a `RequestEvent` to all `onRequest` subscribers.
   * Bails early when no one's listening so the hot path doesn't allocate
   * an event object. Per the V1 probe numbers, eval rate can reach
   * ~4500/sec in listener-storm scenarios — every cycle matters.
   *
   * Subscriber-throw isolation has two layers:
   *   - Sync throws are caught by the try/catch around the invocation.
   *   - Async subscribers that return a rejected Promise (e.g.
   *     `async (e) => { throw }`) have the rejection silently swallowed
   *     by attaching a noop `.catch`. Without this, an
   *     `unhandledRejection` would terminate the sandbox process on
   *     Node ≥15 default config — one bad subscriber would kill every
   *     other observer.
   *
   * Subscriber callbacks are observational; the sandbox doesn't await
   * them and doesn't propagate their errors.
   */
  private emitRequest(input: EmitRequestInput): void {
    if (!this.events.request.hasSubscribers) return;
    this.events.request.emit(buildRequestEvent(input));
  }

  /**
   * Subscribe to snapshot-listener stream errors (Slice 7). Returns an
   * unsubscribe fn. Fires every time a snapshot listener is marked
   * errored — initial fire denial, change-driven re-read denial, or
   * `deployRules` re-evaluation flipping a listener allowed → denied.
   *
   * The callback receives the structured `FirestoreSimError` plus the
   * listener's `SnapshotTarget` so the host UI can attribute the error
   * to a specific watch (e.g. "listener on `games/g1` errored").
   *
   * Per source survey section 9, this is the playground-side channel: stream
   * errors fan out to both the listener's own `errorCallback` AND every
   * env-level subscriber here. Subscriber throws are swallowed so a
   * faulty UI handler can't destabilize the simulator.
   */
  onSnapshotError(
    cb: (err: FirestoreSimError, target: SnapshotTarget, listenerId: string) => void,
  ): () => void {
    return this.events.snapshotError.subscribe(cb);
  }

  // ═══ Snapshot listeners (Slices 1+2) ═══

  /**
   * Register a snapshot listener. Returns an `Unsubscribe` function
   * matching the Web SDK's contract — idempotent after the first detach.
   * Registration, the off-stack initial fire, delivery ordering, and
   * metadata acks live in {@link ListenerDispatch}; the facade keeps the
   * public signature (ADR-0009 decision 4).
   */
  addSnapshotListener(
    target: SnapshotTarget,
    callback: SnapshotCallback,
    options: SnapshotListenerOptions = {},
    auth: ListenerAuth = null,
    errorCallback?: SnapshotErrorCallback,
    /** `true` when the listener follows `sandbox.currentUser` — see
     *  {@link reevaluateLiveListeners}. */
    followsCurrentUser = false,
    /** Preserve the admin lens for the listener's full lifetime. */
    bypassRules = false,
    /** Named app session identity; undefined means the ambient session. */
    authScope?: object,
  ): () => void {
    return this.listeners.addSnapshotListener(
      target,
      callback,
      options,
      auth,
      errorCallback,
      followsCurrentUser,
      bypassRules,
      authScope,
    );
  }


  /**
   * Synchronously deliver all pending snapshot fires. Test-only seam —
   * see {@link ListenerDispatch#flushListeners}.
   */
  flushListeners(): void {
    this.listeners.flushListeners();
  }

  /**
   * Test seam — exposes registry size without leaking the records.
   * Slice 2+ may add a richer accessor when the diff path needs to
   * iterate; for now this is enough to assert add/remove correctness.
   */
  getSnapshotListenerCount(): number {
    return this.listeners.getSnapshotListenerCount();
  }

  /**
   * Tear down the environment's listener registries (Slice 8).
   *
   * Clears every snapshot listener, denial subscriber, and snapshot-error
   * subscriber so the environment drops its references to consumer
   * callbacks. Use case: a host (e.g. the playground runner) is about to
   * discard this `LocalEnvironment` in favor of a fresh one — calling
   * `dispose()` first guarantees that any orphan callbacks held by the
   * outgoing env can no longer be invoked, even if some external code path
   * still holds a reference to the old instance.
   *
   * Idempotent: clearing already-empty sets is a no-op. Does not touch
   * data state (`state` / `eventLog` / `rules`) — `dispose()` is
   * about *callback ownership*, not data lifecycle. Construct a fresh
   * `LocalEnvironment` (or call `seed()`) to reset data.
   */
  dispose(): void {
    this.listeners.dispose();
    this.events.clear();
  }

  /** Seed the environment with rules and initial data. */
  seed(options: {
    rules: string;
    documents?: Record<string, DocumentData>;
    baseDocuments?: Record<string, DocumentData>;
  }): LintResult {
    this.rules.set(options.rules);
    // `baseDocuments` (branch fork): wrap the snapshot as an immutable CoW base
    // instead of cloning it, so the fork is O(1). Reads fall through to the base;
    // branch writes land in the overlay.
    this.state = options.baseDocuments
      ? new LocalState({}, new OverlayBacking(options.baseDocuments))
      : new LocalState(options.documents ?? {});
    // The reset baseline. For a branch it aliases the immutable base (no clone;
    // it is already a stable snapshot). seedSnapshot has no reader today; if a
    // future reset does state.restore(seedSnapshot), clone it first so the base's
    // nested refs are not aliased back into the live keyspace.
    this.seedSnapshot = options.baseDocuments ?? this.state.snapshot();
    this.eventLog.clear();
    return lintFirestoreRules(options.rules);
  }

  /**
   * Deploy new rules (re-lint, swap for next operation).
   *
   * **Slice 6 — re-evaluation.** After a successful swap, every active
   * listener is re-evaluated under the new rules. This **diverges from
   * production** (where rule changes don't affect already-attached
   * listeners) and is intentional per the design rationale
   * section 4.1 — the playground's value is seeing rule changes reflected
   * immediately in live UI. Concretely:
   *   - A doc that was unreadable but is now readable fires a snapshot
   *     (and clears the listener's `errored` flag if applicable).
   *   - A doc that was readable but is now unreadable marks the listener
   *     errored via {@link markErrored}.
   *   - Query listeners diff old↔new readable doc sets; flips surface as
   *     `added` / `removed` change entries.
   */
  deployRules(source: string): LintResult {
    const lint = lintFirestoreRules(source);
    // **Always install.** The previous behavior gated install on
    // `errors.length === 0` and silently no-op'd otherwise — that
    // caused a 51-tool-call debug session where an agent couldn't
    // figure out why its rules weren't applied (CLAUDE_DEBUG_SESSION.md).
    // Lint is *diagnosis*, not enforcement. The dev-loop sandbox installs
    // whatever the caller asks for; CI or a release workflow can enforce a
    // stricter policy before shipping. Callers that care about
    // the lint result still get it back; the `sandbox_inspect`
    // MCP tool surfaces it for agents.
    this.rules.set(source);
    this.listeners.reEvaluateAllListeners();
    return lint;
  }

  /**
   * Re-evaluate every LIVE listener against a new session auth (sign-out /
   * sign-in as a different user). Frozen-ctx listeners stay pinned to the
   * identity captured at registration. See
   * {@link ListenerDispatch#reevaluateLiveListeners} for the full contract.
   */
  reevaluateLiveListeners(newAuth: ListenerAuth, authScope?: object): void {
    this.listeners.reevaluateLiveListeners(newAuth, authScope);
  }

  /** Get current rules source. */
  getRules(): string {
    return this.rules.source;
  }

  // ═══ Read operations (bypass rules — admin access) ═══

  /** Read a document from local state (admin, no rules). */
  getDocument(path: string): DocumentData | null {
    return this.state.get(path);
  }

  /**
   * List documents in a collection (admin, no rules).
   *
   * Includes phantom parent docs (records synthesized for any parent path
   * that has descendants but no stored data of its own). Phantom records
   * carry `phantom: true` and `data: {}` so the discover crawler — which
   * walks structure rather than data — sees the same shape live Firestore
   * would expose. See {@link LocalState#list} for the contract.
   */
  listDocuments(collection: string): { path: string; data: DocumentData; phantom?: true }[] {
    return this.state.list(collection);
  }

  /**
   * Scan documents under a path through the {@link DocStore} seam (admin, no
   * rules). The query engine gathers candidates with `{ directOnly: true }` for
   * a collection's real direct children (no phantoms); the discover crawler
   * still uses {@link listDocuments}, which adds phantom parents.
   */
  scanDocuments(prefix: string, opts?: ScanOptions): DocEntry[] {
    return this.state.scan(prefix, opts);
  }

  /**
   * Rule-enforced collection read — the query (`getDocs` / `Query.get` /
   * aggregate) read path for the web-modular + auth-scoped admin-compat
   * surfaces. Enforcement lives in {@link RulesReadEngine#readQueryCandidates}
   * (ADR-0009, PR B3); the facade keeps the public signature. Engine-internal
   * pending PR C (ADR-0009 decision 6) — admin-compat still supplies raw
   * candidates across the seam until the engine grows a real runQuery().
   */
  readQueryCandidates(
    candidates: { path: string; data: DocumentData }[],
    listPath: string,
    auth: Operation['auth'],
    query?: QueryConstraints,
    bypassRules?: boolean,
    activityQuery?: unknown,
  ): { allowed: true; docs: { path: string; data: DocumentData }[] } | { allowed: false; error: FirestoreSimError } {
    return this.reads.readQueryCandidates(candidates, listPath, auth, query, bypassRules, activityQuery);
  }

  /**
   * List root collection IDs derived from the in-memory keyspace.
   * Used by the discover/crawler adapter so `firestore_discover_paths`
   * can run against the simulator without hitting live Firestore.
   */
  listRootCollections(): string[] {
    return this.state.listRootCollections();
  }

  /**
   * List subcollection IDs underneath the given document path.
   * Companion to {@link listRootCollections} for the discover/crawler adapter.
   */
  listSubcollections(docPath: string): string[] {
    return this.state.listSubcollections(docPath);
  }

  /** Get full state snapshot. */
  snapshot(): Record<string, DocumentData> {
    return this.state.snapshot();
  }

  /**
   * Capture the prior state of just the given paths (for single-write / batch
   * undo), as `{ path: priorData | null }` where `null` records a doc that did
   * not exist. The affected-path alternative to a whole-keyspace
   * {@link snapshot}, so the undo stack stays O(affected) not O(keyspace).
   * Must be called BEFORE the write applies.
   */
  private capturePriors(paths: readonly string[]): Record<string, DocumentData | null> {
    return this.writes.capturePriors(paths);
  }

  // ═══ Write operations (bypass rules — admin access) ═══

  /**
   * Replace a document at `path` (admin, no rules). `set` semantics —
   * creates if absent, overwrites if present, no merge. Wakes any
   * active listeners attached to `path` so subscriptions see the
   * change live, mirroring what a rule-allowed `set` would do.
   */
  adminSetDocument(path: string, data: DocumentData): void {
    this.state.set(path, data ?? {});
    this.listeners.notifyListenersForPaths(new Set([path]));
  }

  /**
   * Delete a document at `path` (admin, no rules). Returns
   * `{ deleted }` reflecting whether a doc was actually removed
   * (`false` if the path didn't exist). Idempotent — a no-op on a
   * missing path does not throw. Wakes listeners on `path`.
   */
  adminDeleteDocument(path: string): { deleted: boolean } {
    const r = this.state.delete(path);
    if (r.success) {
      this.listeners.notifyListenersForPaths(new Set([path]));
    }
    return { deleted: r.success };
  }

  /**
   * Run the rules engine for the given test cases — UNLESS `bypassRules`
   * is set, in which case the rules engine is skipped entirely and a
   * synthetic all-ALLOW result is returned (Pyric Studio Gap #2 admin
   * lens). Every `simulate()` call site in `execute` / `batch` /
   * `transaction` routes through here so the bypass is centralized and
   * the rules-enforced path is byte-for-byte unchanged when `bypassRules`
   * is absent/false.
   *
   * The synthetic result mirrors the engine's success shape
   * (`{ success: true, data: { results, passed, failed, unsupported } }`)
   * with one PASSED entry per test case, so callers that read
   * `simResult.data.results[i]` see a normal ALLOW with no special-casing.
   */
  private runSimulate(
    testCases: TestCase[],
    bypassRules: boolean | undefined,
    batchProjection?: Map<string, DocumentData | null>,
  ): TestFirestoreRulesResult {
    return this.writes.runSimulate(testCases, bypassRules, batchProjection);
  }

  /**
   * getafter-batch fix — build the shared post-commit projection for an
   * atomic batch/transaction, ONCE, before evaluating any per-op rule.
   * Every op in `testCases` gets folded in: `create`/`update` project to
   * the full post-write document (already merged by `buildTestCase`),
   * `delete` projects to `null` (doc gone). `get`/`list` ops don't write
   * and are skipped — they never change what `getAfter` should see.
   *
   * Passing the SAME map into every per-op `simulate()` call for the group
   * is what lets doc A's rule see doc B's pending write via `getAfter(B)`
   * — mirrors the RTDB rules multi-path projection (one shared tree built
   * up front, read by every path's rule eval) applied to Firestore's
   * per-document `getAfter()`.
   */
  private buildBatchProjection(testCases: TestCase[]): Map<string, DocumentData | null> {
    return this.writes.buildBatchProjection(testCases);
  }

  // ═══ Single operation (rules evaluated) ═══

  /** Execute a single operation. Rules are evaluated against local state.
   *  When `operation.bypassRules` is set, rule evaluation is skipped (admin
   *  lens — Studio Gap #2): the op is treated as ALLOW and routed through
   *  the same apply + emit path, so structural preconditions, events, and
   *  listeners behave exactly as a rule-allowed op would. */
  execute(operation: Operation): OperationResult {
    return this.writes.execute(operation);
  }
  // ═══ Auto-ID create ═══

  /**
   * Item 7 — `addDoc()`-style create with a Firestore-compatible auto ID.
   *
   * Mirrors the live SDK's `addDoc(collection(db, c), data)` flow: mint a
   * 20-char alphanumeric document ID, append it to the collection path,
   * then run the same `execute({ method: 'create', ... })` pipeline that
   * an explicit-ID create would (rules, sentinel resolution, applyWrite).
   * The minted path is returned so callers can re-read the doc without
   * having to capture the ID via a side channel.
   */
  createWithAutoId(
    collection: string,
    data: DocumentData,
    auth: Operation['auth'],
    bypassRules?: boolean,
  ): { path: string; result: OperationResult } {
    return this.writes.createWithAutoId(collection, data, auth, bypassRules);
  }
  // ═══ Batch operations ═══

  /** Execute multiple writes atomically. All must pass rules or none apply. */
  batch(
    operations: BatchOperationInput[],
    auth: Operation['auth'],
    bypassRules?: boolean,
  ): BatchResult {
    return this.writes.batch(operations, auth, bypassRules);
  }
  // ═══ Transactions ═══

  /**
   * Run a callback inside a Firestore-style transaction.
   *
   * The callback may be synchronous or async — return a `Promise` and
   * the method returns `Promise<TransactionResult<R>>`; return a value
   * (or void) and the method returns `TransactionResult<R>` directly.
   * This mirrors the Admin SDK's `runTransaction(fn)` signature, which
   * accepts both shapes.
   *
   * Lifecycle:
   *   1. Build a `TransactionContext` with the read callback bound to
   *      `this.state.get` (admin-mode reads, no rules eval — probe 0.B).
   *   2. Invoke `fn(tx)`. If it returns a Promise, await before
   *      continuing — sentinel resolution, rules eval, and applyBatch
   *      all happen AFTER the callback fully resolves.
   *      - Throws (including `ReadAfterWriteError` from probe 0.A/0.J,
   *        `AmbiguousPostDeleteWriteError` from the merge layer, or any
   *        user error) propagate unchanged after an aborted-tx event is
   *        logged. Probe 0.G: custom Error properties survive.
   *   3. Merge same-path queued writes (Item 1.3) into `BatchOperation[]`.
   *   4. Resolve sentinels against pre-tx state (one `serverTime` for the
   *      whole tx — mirrors `batch()` semantics). For async callbacks
   *      `serverTime` is pinned at commit time, AFTER the await — so
   *      `serverTimestamp()` reflects when the writes are actually
   *      committed, not when the read happened.
   *   5. Per-op rules evaluation against PRE-tx state. No inter-write
   *      visibility (extrapolated from batch parity, probe 0.E). For a
   *      queued `set`, rules eval under `create` if the doc is missing
   *      pre-tx, else `update` — `applyBatch` still runs the `set` op.
   *   6. If every write passes rules, run `applyBatch` atomically.
   *      Structural failures (create-already-exists, update/delete-
   *      missing) demote per-op `allowed` and surface typed errors —
   *      matches single-op + batch behavior.
   *   7. Append a single `type: 'transaction'` `AgentEvent` carrying
   *      `reads[]`, `operations[]`, and a pre-tx snapshot for undo.
   */
  // Overloads keep the return type narrow: async-in → Promise-out,
  // sync-in → value-out. Without these, TS would widen to `unknown`.
  transaction<R>(
    fn: (tx: Transaction) => Promise<R>,
    options: TransactionOptions,
  ): Promise<TransactionResult<R>>;
  transaction<R>(
    fn: (tx: Transaction) => R,
    options: TransactionOptions,
  ): TransactionResult<R>;
  transaction<R>(
    fn: (tx: Transaction) => R | Promise<R>,
    options: TransactionOptions,
  ): TransactionResult<R> | Promise<TransactionResult<R>> {
    const auth = options.auth;
    const snapshot = this.state.snapshot();

    const reader: TransactionReader = (path) => this.state.get(path);
    const ctx = new TransactionContext(reader);

    // ─── Step 2 — run the callback ───────────────────────────────────
    let cbResult: R | Promise<R>;
    try {
      cbResult = fn(ctx);
    } catch (e) {
      // Sync throw before any await: log + re-throw immediately.
      this.logAbortedTransaction(ctx, auth, e as Error);
      throw e;
    }

    // Async path — await, then commit. Reject mirrors the sync throw
    // case (probe 0.G: original error reference re-thrown).
    if (cbResult !== null && typeof (cbResult as PromiseLike<R>)?.then === 'function') {
      return (cbResult as Promise<R>).then(
        (returnValue) => this.commitTransaction(ctx, auth, snapshot, options, returnValue),
        (e) => {
          this.logAbortedTransaction(ctx, auth, e as Error);
          throw e;
        },
      );
    }

    // Sync path.
    return this.commitTransaction(ctx, auth, snapshot, options, cbResult as R);
  }

  /**
   * Commit phase shared by sync + async transaction paths. Runs after
   * the callback has fully completed (sync return or awaited resolve).
   * Splitting this out keeps `transaction()` readable and keeps the
   * commit logic from being duplicated across the two branches.
   */
  private commitTransaction<R>(
    ctx: TransactionContext,
    auth: TransactionOptions['auth'],
    snapshot: Record<string, DocumentData>,
    options: TransactionOptions,
    returnValue: R,
  ): TransactionResult<R> {
    const { reads, writes } = ctx.consume();
    const detail = options.bypassRules ? { admin: true } : undefined;
    // Issue #307 — shared groupId so consumers can fold tx sub-ops
    // together the same way they fold batch sub-ops.
    const txId = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // Per-write `RequestEvent`s queued during evaluation; emitted at
    // the end of step 6 with finalized `resourceAfter`. Mirrors the
    // pattern used in `batch()` (see line ~1410).
    const pendingEmits: EmitRequestInput[] = [];

    // ─── Read-only short-circuit ─────────────────────────────────────
    // Zero queued writes is the locked happy path for read-only
    // transactions (probe 0.F): commit cleanly with `writes: []`.
    if (writes.length === 0) {
      const event = this.eventLog.append({
        type: 'transaction',
        method: 'transaction',
        path: '',
        auth: auth ? { uid: auth.uid } : null,
        allowed: true,
        reads: reads.map((r) => ({ path: r.path, data: r.data })),
        operations: [],
        snapshot,
        debugMessages: ['Transaction committed (read-only — no writes queued)'],
      });
      return {
        allowed: true,
        reads: [...reads],
        writes: [],
        returnValue,
        event,
      };
    }

    // ─── Step 3 — merge same-path queued writes ──────────────────────
    let mergedOps: BatchOperation[];
    try {
      mergedOps = mergeQueuedWrites(writes);
    } catch (e) {
      const err = e as Error;
      this.eventLog.append({
        type: 'transaction',
        method: 'transaction',
        path: '',
        auth: auth ? { uid: auth.uid } : null,
        allowed: false,
        aborted: true,
        reads: reads.map((r) => ({ path: r.path, data: r.data })),
        error: { name: err.name, message: err.message, code: 'failed-precondition' },
        debugMessages: [`Transaction aborted at merge: ${err.message}`],
      });
      // Re-throw the original — callers that want a typed code can
      // catch `AmbiguousPostDeleteWriteError` from transaction-merge.ts.
      throw e;
    }

    // ─── Step 4 — resolve sentinels ──────────────────────────────────
    // One serverTime for the whole tx; matches batch() and single-op
    // semantics so `request.time` and any `serverTimestamp()` resolve
    // to the same wall-clock instant within a tx.
    const serverTime = Timestamp.fromMillis(Date.now());
    const resolvedOps: BatchOperation[] = [];
    for (const op of mergedOps) {
      if (op.method === 'delete') {
        resolvedOps.push(op);
        continue;
      }
      try {
        const resolved = resolveValueTree({ ...op.data! }, {
          path: op.path,
          method: op.method as ResolveMethod,
          prior: this.state.get(op.path),
          serverTime,
        });
        resolvedOps.push({ ...op, data: resolved });
      } catch (e) {
        const msg = (e as Error).message;
        const wrapped = makeError('invalid-argument', msg);
        const event = this.eventLog.append({
          type: 'transaction',
          method: 'transaction',
          path: '',
          auth: auth ? { uid: auth.uid } : null,
          allowed: false,
          reads: reads.map((r) => ({ path: r.path, data: r.data })),
          operations: mergedOps.map((o) => ({
            method: o.method,
            path: o.path,
            data: o.data,
            allowed: false,
          })),
          debugMessages: [`FieldValue resolve error on '${op.path}': ${msg}`],
        });
        // Issue #307 — surface the failing op as a denied request
        // (mirrors the batch() resolve-error path at line ~1438).
        // Earlier ops in the loop succeeded silently; later ops never
        // reached evaluation. Only the failing op emits.
        const opRuleMethod = (op.method === 'set'
          ? this.state.get(op.path) !== null
            ? 'update'
            : 'create'
          : op.method) as 'create' | 'update' | 'delete';
        const priorDoc = snapshot[op.path] ?? null;
        this.emitRequest({
          at: Date.now(), evalMs: 0,
          method: opRuleMethod, path: op.path, auth, result: 'deny',
          debugMessages: [`FieldValue resolve error: ${msg}`],
          ...(op.data && opRuleMethod !== 'delete' ? { resourceData: op.data } : {}),
          resourceBefore: { data: priorDoc, exists: priorDoc !== null },
          origin: 'transaction', groupId: txId,
          ...(detail ? { detail } : {}),
          provenance: options.provenance,
        });
        return {
          allowed: false,
          reads: [...reads],
          writes: mergedOps.map((o) => {
            const ruleMethod =
              o.method === 'set'
                ? this.state.get(o.path) !== null
                  ? 'update'
                  : 'create'
                : o.method;
            return {
              path: o.path,
              method: ruleMethod as 'create' | 'update' | 'delete',
              allowed: false,
              debugMessages: o.path === op.path ? [msg] : [],
              ...(o.path === op.path ? { error: wrapped } : {}),
            };
          }),
          returnValue,
          event,
          error: wrapped,
        };
      }
    }

    // ─── Step 5 — per-op rules evaluation against pre-tx state ───────
    // getafter-batch fix: build the shared post-commit projection ONCE for
    // the whole transaction (same approach as batch(), same helper) so
    // `getAfter()` on a sibling write-in-progress doc sees this
    // transaction's other pending writes, not just its own.
    const txTestCases = resolvedOps.map((op) => {
      const exists = this.state.get(op.path) !== null;
      const ruleMethod = (op.method === 'set'
        ? exists
          ? 'update'
          : 'create'
        : op.method) as 'create' | 'update' | 'delete';
      return this.buildTestCase({ method: ruleMethod, path: op.path, auth, data: op.data }, serverTime);
    });
    const txProjection = this.buildBatchProjection(txTestCases);

    const writeResults: TransactionResult<R>['writes'] = [];
    let allAllowed = true;
    for (let i = 0; i < resolvedOps.length; i++) {
      const op = resolvedOps[i]!;
      // Pre-resolution payload (parallel to resolvedOps by index).
      // Emitted on RequestEvent/WriteSandboxEvent so consumers see the
      // user's INTENT with FieldValue.* markers, not materialized values.
      const preData = mergedOps[i]?.data;
      // Translate `set` → `create`/`update` for rules-eval purposes
      // only; applyBatch keeps `set` semantics. Admin's rules engine
      // dispatches a `set` to whichever lifecycle matches the pre-tx
      // state, and we mirror that.
      const exists = this.state.get(op.path) !== null;
      const ruleMethod = (op.method === 'set'
        ? exists
          ? 'update'
          : 'create'
        : op.method) as 'create' | 'update' | 'delete';
      const priorDoc = snapshot[op.path] ?? null;

      const testCase = txTestCases[i]!;
      const evalAt = Date.now();
      const evalStart = performance.now();
      const sim = this.runSimulate([testCase], options.bypassRules, txProjection);
      const evalMs = performance.now() - evalStart;

      if (!sim.success) {
        writeResults.push({
          path: op.path,
          method: ruleMethod,
          allowed: false,
          debugMessages: [sim.error.message],
          error: makeError('invalid-argument', sim.error.message),
        });
        pendingEmits.push({
          at: evalAt, evalMs, method: ruleMethod, path: op.path, auth,
          result: 'deny',
          debugMessages: [`Simulation error: ${sim.error.message}`],
          ...(preData && ruleMethod !== 'delete' ? { resourceData: preData } : {}),
          resourceBefore: { data: priorDoc, exists: priorDoc !== null },
          origin: 'transaction', groupId: txId,
          ...(detail ? { detail } : {}),
          provenance: options.provenance,
        });
        allAllowed = false;
        continue;
      }

      const r = sim.data.results[0];
      if (r.state === 'UNSUPPORTED') {
        // Surface the unsupported event before throwing — same
        // contract as execute() / batch().
        this.emitRequest({
          at: evalAt, evalMs, method: ruleMethod, path: op.path, auth,
          result: 'unsupported', debugMessages: renderLegacyDebugMessages(r),
          ...(preData && ruleMethod !== 'delete' ? { resourceData: preData } : {}),
          resourceBefore: { data: priorDoc, exists: priorDoc !== null },
          origin: 'transaction', groupId: txId,
          ...(detail ? { detail } : {}),
          provenance: options.provenance,
        });
        throw new SimulatorUnsupportedError(
          unsupportedMessage(ruleMethod, op.path, renderLegacyDebugMessages(r)),
          ruleMethod,
          op.path,
          renderLegacyDebugMessages(r),
        );
      }

      const isAllowed = r.state === 'PASSED';
      const entry: TransactionResult<R>['writes'][number] = {
        path: op.path,
        method: ruleMethod,
        allowed: isAllowed,
        debugMessages: renderLegacyDebugMessages(r),
      };
      // Queue the per-write RequestEvent. resourceAfter is filled in
      // after the atomic apply below (step 6) so denied ops show the
      // pre-tx state and committed ops show the post-tx state.
      pendingEmits.push({
        at: evalAt, evalMs, method: ruleMethod, path: op.path, auth,
        result: isAllowed ? 'allow' : 'deny',
        debugMessages: renderLegacyDebugMessages(r),
        ...(preData && ruleMethod !== 'delete' ? { resourceData: preData } : {}),
        resourceBefore: { data: priorDoc, exists: priorDoc !== null },
        origin: 'transaction', groupId: txId,
        ...(detail ? { detail } : {}),
        provenance: options.provenance,
      });
      if (!isAllowed) {
        // Per-op `request`/`resource` captured against pre-tx snapshot
        // so a denial inside a transaction shows the same shape as a
        // single-op denial (auth + resourceData + existing doc).
        const priorDoc = snapshot[op.path] ?? null;
        entry.error = makeError(
          'permission-denied',
          `${ruleMethod} ${op.path} denied by rules`,
          {
            request: {
              method: ruleMethod,
              path: op.path,
              auth,
              ...(preData && ruleMethod !== 'delete' ? { resourceData: preData } : {}),
            },
            resource: { data: priorDoc, exists: priorDoc !== null },
          },
        );
        this.emitDenial(entry.error);
        allAllowed = false;
      }
      writeResults.push(entry);
    }

    // ─── Step 6 — atomic apply (only if all rules passed) ────────────
    let structuralError: FirestoreSimError | null = null;
    if (allAllowed) {
      const applyResult = this.state.applyBatch(resolvedOps);
      if (!applyResult.success) {
        allAllowed = false;
        const first = applyResult.errors?.[0];
        if (first !== undefined) {
          const failingOp = resolvedOps[first.index];
          // `set` cannot raise a structural error in applyBatch; only
          // create/update/delete can — so this branch hits only those
          // methods. The ternary keeps the type narrow.
          const code =
            failingOp?.method === 'create' ? 'already-exists' : 'not-found';
          structuralError = makeError(code, first.error);
          const failingResult = writeResults[first.index];
          if (failingResult) {
            failingResult.allowed = false;
            failingResult.error = structuralError;
          }
        }
      }
    }

    // ─── Step 7 — log event + assemble result ────────────────────────
    const event = this.eventLog.append({
      type: 'transaction',
      method: 'transaction',
      path: '',
      auth: auth ? { uid: auth.uid } : null,
      allowed: allAllowed,
      reads: reads.map((r) => ({ path: r.path, data: r.data })),
      operations: resolvedOps.map((op, i) => ({
        method: op.method,
        path: op.path,
        data: op.data,
        allowed: writeResults[i]?.allowed ?? false,
      })),
      // Snapshot is captured for undo only on success — a rolled-back
      // tx mutated nothing, so there's nothing to restore. Matches
      // batch() behavior exactly.
      snapshot: allAllowed ? snapshot : undefined,
      debugMessages: allAllowed
        ? ['Transaction committed']
        : ['Transaction rolled back — one or more operations denied'],
    });

    // Issue #307 — fire the per-write RequestEvents + WriteSandboxEvents
    // queued in step 5. resourceAfter mirrors `batch()`: committed ops
    // show the post-apply doc; denied/rolled-back ops show the pre-tx
    // state. Only committed writes emit a WriteSandboxEvent.
    for (let i = 0; i < pendingEmits.length; i++) {
      const e = pendingEmits[i]!;
      const opCommitted = allAllowed && writeResults[i]?.allowed === true;
      if (opCommitted) {
        const finalDoc = this.state.get(e.path);
        if (e.method !== 'delete') {
          e.resourceAfter = { data: finalDoc, exists: finalDoc !== null };
        } else {
          e.resourceAfter = { data: null, exists: false };
        }
      } else {
        const priorDoc = snapshot[e.path] ?? null;
        e.resourceAfter = { data: priorDoc, exists: priorDoc !== null };
      }
      this.emitRequest(e);
      if (opCommitted && e.method !== 'get' && e.method !== 'list') {
        const priorDoc = snapshot[e.path] ?? null;
        // Sentinels: walk the PRE-resolution data from `mergedOps[i]`
        // (parallel to resolvedOps and pendingEmits).
        const preOp = mergedOps[i];
        const sentinels =
          preOp && preOp.method !== 'delete' && preOp.data
            ? walkForSentinels(preOp.data)
            : undefined;
        this.emitWrite({
          method: e.method as 'create' | 'update' | 'set' | 'delete',
          path: e.path,
          auth,
          ...(e.method !== 'delete' && e.resourceData ? { data: e.resourceData } : {}),
          priorState: priorDoc,
          nextState: e.method === 'delete' ? null : this.state.get(e.path),
          ...(e.groupId ? { groupId: e.groupId, groupKind: 'transaction' as const } : {}),
          ...(sentinels && sentinels.length > 0 ? { sentinels } : {}),
          requestTime: serverTime,
          ...(detail ? { detail } : {}),
          provenance: options.provenance,
        });
      }
    }

    let topError: FirestoreSimError | undefined;
    if (!allAllowed) {
      topError =
        structuralError ??
        writeResults.find((w) => w.error)?.error ??
        makeError('permission-denied', 'Transaction denied');
    }

    const result: TransactionResult<R> = {
      allowed: allAllowed,
      reads: [...reads],
      writes: writeResults,
      returnValue,
      event,
      ...(topError ? { error: topError } : {}),
    };
    // Probe 0.H side-finding: warn-not-throw on writes inside a
    // readOnly tx. v1 still queues + commits the write; v2 may flip to
    // strict (throw at the call site).
    if (options.readOnly && ctx.hadWrites()) {
      result.readOnlyViolation = true;
    }
    // Slice 3 — fan out transaction writes after a successful commit.
    // Aborted transactions never reach here (the throw in `transaction`
    // bypasses commit entirely), and rolled-back commits leave state
    // unchanged so we'd suppress everything anyway. Single fire per
    // transaction matches the Slice 5 design.
    if (allAllowed) {
      const touched = new Set<string>();
      for (const op of resolvedOps) touched.add(op.path);
      // Issue #307 — listener re-evals attribute to the transaction.
      const firstOp = resolvedOps[0];
      this.triggerScope.run(
        { method: 'transaction', path: firstOp?.path ?? '' },
        () => this.listeners.notifyListenersForPaths(touched),
      );
    }
    return result;
  }

  /**
   * Append an aborted-transaction event for a callback throw (sync or
   * async path). The original Error is re-thrown by the caller —
   * probe 0.G locks "exceptions propagate unchanged", so this helper
   * never throws on its own.
   */
  private logAbortedTransaction(
    ctx: TransactionContext,
    auth: TransactionOptions['auth'],
    err: Error,
  ): void {
    const errWithCode = err as Error & { code?: unknown };
    const { reads } = ctx.consume();
    this.eventLog.append({
      type: 'transaction',
      method: 'transaction',
      path: '',
      auth: auth ? { uid: auth.uid } : null,
      allowed: false,
      aborted: true,
      reads: reads.map((r) => ({ path: r.path, data: r.data })),
      error: {
        name: err.name,
        message: err.message,
        ...(errWithCode.code !== undefined ? { code: String(errWithCode.code) } : {}),
      },
      debugMessages: [`Transaction aborted: ${err.message}`],
    });
  }

  // ═══ Undo / Redo ═══

  /** Undo the last write operation. Restores the affected paths (single-write /
   *  batch) or the whole keyspace (transaction) to their pre-write state. */
  undo(): AgentEvent | null {
    return this.history.undo();
  }

  /** Redo the last undone operation. Re-applies the write directly
   *  without going through execute() (which would clear the redo stack). */
  redo(): OperationResult | null {
    return this.history.redo();
  }

  // ═══ Event log access ═══

  /** Get all events. */
  getEvents(): AgentEvent[] {
    return this.history.getEvents();
  }

  /** Get event count. */
  getEventCount(): number {
    return this.history.getEventCount();
  }

  // ═══ Private helpers ═══

  private buildTestCase(operation: Operation, serverTime?: Timestamp): TestCase {
    const existingDoc = this.state.get(operation.path);

    // Translate `set` to the rules-engine clause it routes through —
    // `create` for missing docs, `update` for existing. Storage stays
    // `set` (handled in applyWrite) so the post-write doc is the
    // replacement payload, not a merge.
    const ruleMethod: TestCase['method'] = operation.method === 'set'
      ? (existingDoc !== null ? 'update' : 'create')
      : (operation.method as TestCase['method']);

    // For reads: no request data (reads don't send data)
    // For writes: build the FULL post-write document
    let requestData = operation.data;
    if (operation.method === 'get' || operation.method === 'list') {
      requestData = undefined;
    } else if (operation.method === 'update' && existingDoc && operation.data) {
      // Merge: existing + updates = full post-write document. Item 2:
      // partition DELETE_FIELD markers so the rules see the same shape
      // storage will see (deleted keys absent, not present-with-symbol).
      // The data has already been resolved upstream — partitionDeletes
      // is idempotent on already-partitioned trees.
      const { writes, deletedKeys } = partitionDeletes(operation.data);
      const merged: DocumentData = { ...existingDoc, ...writes };
      for (const k of deletedKeys) delete merged[k];
      requestData = merged;
    } else if (operation.data) {
      // create / set: the resolved data IS the full post-write doc
      // (set replaces). Strip any DELETE_FIELD markers so they don't
      // reach the handler.
      requestData = partitionDeletes(operation.data).writes;
    }

    return {
      description: `${operation.method} ${operation.path}`,
      expectation: 'ALLOW', // We always test against ALLOW; FAILED = denied
      method: ruleMethod,
      path: operation.path,
      auth: operation.auth ? { uid: operation.auth.uid, token: operation.auth.token } : null,
      data: requestData,
      resource: existingDoc ?? undefined,
      // Phase 2: no whole-keyspace functionMocks dump. get()/exists() in rules
      // fault in lazily through the `getDoc` resolver passed to simulate() (a
      // DocStore point-read), resolving only the paths a ruleset actually touches.
      // Item 1: forward the resolver's serverTime as ISO so handler.ts's
      // `request.time` is field-equal to any resolved sentinel.
      // Millisecond-precise round-trip via Date(ms).toISOString() ↔
      // Timestamp.fromIsoString.
      ...(serverTime ? { requestTime: isoFromTimestamp(serverTime) } : {}),
    };
  }

  /**
   * Apply a write to local state, returning a structural error when
   * the underlying state operation rejects (Item 6). Rules have already
   * decided to ALLOW by the time we get here; what's left are the
   * preconditions only the keyspace knows about — `create` of an
   * existing path, `update`/`delete` of a missing path. The simulator
   * previously dropped these silently (state.create returned
   * `{success:false}` and we ignored it), which let `allowed:true`
   * results coexist with no actual mutation. Returning the failure
   * lets `execute()` demote `allowed` and surface the right error code.
   */
  private applyWrite(
    method: string,
    path: string,
    data?: DocumentData,
    merge?: boolean | { mergeFields: readonly string[] },
  ): FirestoreSimError | null {
    // FS-B6: a merge write (`setDoc(data, {merge})`) deep-merges into the
    // existing doc (creating it when absent), regardless of whether rule
    // eval ran as create or update. Route both to `setMerge`.
    if (merge !== undefined && merge !== false && (method === 'create' || method === 'update')) {
      const mergeFields = merge === true ? undefined : merge.mergeFields;
      this.state.setMerge(path, data ?? {}, mergeFields);
      return null;
    }
    switch (method) {
      case 'create': {
        const r = this.state.create(path, data ?? {});
        if (!r.success) {
          return makeError('already-exists', r.error ?? `Document '${path}' already exists`);
        }
        return null;
      }
      case 'update': {
        const r = this.state.update(path, data ?? {});
        if (!r.success) {
          return makeError('not-found', r.error ?? `Document '${path}' does not exist`);
        }
        return null;
      }
      case 'set': {
        // Replace semantics. `state.set` always succeeds (creates if
        // absent, replaces if present) — matches Firestore `set()`
        // without merge options.
        this.state.set(path, data ?? {});
        return null;
      }
      case 'delete': {
        // `deleteDoc` on a missing doc is a no-op in production
        // `firebase/firestore` (and the Admin SDK): rules already
        // allowed, the doc isn't there to remove, and the call
        // resolves without throwing. Locked by oracle observation
        // `packages/conformance/observations/firestore/firestore-deletedoc-missing.json`
        // (matrix row Firestore #39). `state.delete` returns
        // `success:false` for a missing path; we collapse that into
        // null (no error) so `execute()` reports the delete as
        // allowed with no mutation, matching prod.
        this.state.delete(path);
        return null;
      }
      default:
        return null;
    }
  }
}
