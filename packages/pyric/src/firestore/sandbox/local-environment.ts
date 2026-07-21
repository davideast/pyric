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
} from './local-state.js';
import { OverlayBacking } from './overlay-backing.js';
import { EventLog, type AgentEvent } from './event-log.js';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { lintFirestoreRules, type LintResult } from 'pyric/rules/internal';
// RULES-B11 — query-proof gate for list reads ("rules are not filters").
import type { QueryConstraints } from './list-query-proof.js';
import type { FirestoreSimError } from './errors.js';
import type { QueryExecutionSpec, QueryScope } from './query-execution.js';
import type {
  Transaction,
  TransactionOptions,
  TransactionResult,
} from './transaction-types.js';
import type {
  ListenerAuth,
  SnapshotCallback,
  SnapshotErrorCallback,
  SnapshotListenerOptions,
  SnapshotTarget,
} from './snapshot-listeners.js';
import type {
  ListenerLifecycleEvent,
  RequestEvent,
  SnapshotDeliveryEvent,
  SnapshotSuppressedEvent,
  WriteSandboxEvent,
} from '../../sandbox/types/events.js';

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
  ReadOperation,
  WriteOperation,
} from './writes.js';
export { SimulatorUnsupportedError } from './rules-evaluation.js';
import { FirestoreEventBus } from './event-bus.js';
import { TriggerScope } from './trigger-scope.js';
import { ListenerDispatch } from './listener-dispatch.js';
import { HistoryControls } from './history-controls.js';
import { RulesState } from './rules-state.js';
import { RulesReadEngine } from './rules-read-engine.js';
import { WriteEngine } from './write-engine.js';
import {
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
  /** The engine's seven observational event channels. */
  private readonly events = new FirestoreEventBus();

  /**
   * The trigger-attribution baton (ADR-0009 decision 3), shared by write
   * execution and listener dispatch. See {@link TriggerScope} for semantics.
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
    // Rules-gated reads need live keyspace access (`seed()` replaces state).
    this.reads = new RulesReadEngine(
      this.events,
      this.triggerScope,
      this.rules,
      this.simulator,
      { get state() { return engine.state; } },
      this.eventLog,
    );
    // Listener dispatch calls back into the engine only for rules-gated
    // silent reads — RulesReadEngine IS its ListenerDispatchHost.
    this.listeners = new ListenerDispatch(this.events, this.triggerScope, this.reads);
    this.writes = new WriteEngine(
      {
        get state() { return engine.state; },
        notifyListenersForPaths: (paths) => engine.listeners.notifyListenersForPaths(paths),
      },
      this.rules,
      this.simulator,
      this.eventLog,
      this.events,
      this.triggerScope,
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


  /**
   * Subscribe to every evaluated op (issue #307). Returns an unsubscribe
   * fn. The emit sites in `execute`, `batch`, `silentReadDoc`,
   * `silentReadCollection` build the public-shape event lazily — when
   * no subscribers are attached, eval doesn't pay the allocation cost.
   */
  onRequest(cb: (event: RequestEvent) => void): () => void {
    return this.events.request.subscribe(cb);
  }

  /**
   * Subscribe to committed-write events. Internal — bridged to the
   * public `Sandbox.onEvent` channel by SandboxImpl. Fires AFTER the
   * keyspace applies the write; denied / rolled-back writes don't
   * emit here.
   */
  onWrite(cb: (event: WriteSandboxEvent) => void): () => void {
    return this.events.write.subscribe(cb);
  }

  /** Internal — bridge for sandbox-level `onEvent` to receive
   *  snapshot-delivery events. Fires after the user callback runs. */
  onSnapshotDelivery(cb: (event: SnapshotDeliveryEvent) => void): () => void {
    return this.events.delivery.subscribe(cb);
  }

  /** Internal bridge for snapshot_suppressed events — re-evals that
   *  didn't deliver because diffing found no observable change. */
  onSnapshotSuppressed(cb: (event: SnapshotSuppressedEvent) => void): () => void {
    return this.events.suppressed.subscribe(cb);
  }

  /** Internal bridge for listener attach/detach lifecycle. Errored
   *  routes through onSnapshotError separately. */
  onListenerLifecycle(cb: (event: ListenerLifecycleEvent) => void): () => void {
    return this.events.lifecycle.subscribe(cb);
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

  /** Execute and rule-check a query without exposing raw candidates. */
  runQuery(
    scope: QueryScope,
    listPath: string,
    auth: Operation['auth'],
    execution: QueryExecutionSpec,
    query?: QueryConstraints,
    bypassRules?: boolean,
    activityQuery?: unknown,
  ): { allowed: true; docs: { path: string; data: DocumentData }[] } | { allowed: false; error: FirestoreSimError } {
    return this.reads.runQuery(
      scope,
      listPath,
      auth,
      execution,
      query,
      bypassRules,
      activityQuery,
    );
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


  // ═══ Single operation (rules evaluated) ═══

  /** Execute a single operation. Rules are evaluated against local state.
   *  When `operation.bypassRules` is set, rule evaluation is skipped (admin
   *  lens — Studio Gap #2): the op is treated as ALLOW and routed through
   *  the same apply + emit path, so structural preconditions, events, and
   *  listeners behave exactly as a rule-allowed op would. */
  execute(operation: Operation): OperationResult {
    if (operation.method === 'get' || operation.method === 'list') {
      return this.reads.execute(operation as ReadOperation);
    }
    return this.writes.execute(operation as WriteOperation);
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
    return this.writes.transaction(
      fn as (tx: Transaction) => R,
      options,
    ) as TransactionResult<R> | Promise<TransactionResult<R>>;
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

}
