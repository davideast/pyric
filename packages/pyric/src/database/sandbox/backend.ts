/**
 * RTDB sandbox backend — the data-plane that the modular SDK's
 * sandbox / sandbox-live targets dispatch into.
 *
 * Responsibilities:
 *   - Hold the in-memory JSON tree (`DataTree`).
 *   - Run identity-aware rule checks via `RulesEvaluator`.
 *   - Resolve `serverTimestamp()` sentinels at the write boundary.
 *   - Mint RTDB-shaped push IDs.
 *   - Fan out `onValue` / child listeners on write.
 *
 * One backend instance per `Sandbox` (the modular surface tracks the
 * binding via a WeakMap so the same sandbox produces the same
 * backend). The backend itself is identity-agnostic; the caller passes
 * `AuthState` per op.
 *
 * Rule-evaluation oracle: the internal RTDB simulator handler. The
 * backend never reimplements rule semantics — it just packages the
 * input shape the simulator expects.
 */
import type { AuthState, Sandbox } from 'pyric/sandbox';
import {
  emitSandboxEvent,
  makeSandboxCommitEvent,
  makeSandboxListenerEvent,
  makeSandboxOperationEvent,
  makeServiceMutationEvent,
} from 'pyric/sandbox/internal';
import {
  DataTree,
  cloneJson,
  jsonValuesEqual,
  joinPath,
  pathSegments,
  type JsonValue,
} from './data-tree.js';
import { generatePushId } from './push-id.js';
import { resolveSentinels } from './sentinels.js';
import {
  RulesEvaluator,
  permissionDenied,
  type RuleCheck,
  type RuleEvaluationDetails,
} from './rules-eval.js';
import {
  compareValues,
  executeQuery,
  extractOrderValue,
  type Priority,
  type QueryRow,
  type QuerySpec,
} from './query.js';

/**
 * Maps a non-`'allow'` rule check to the event-stream `result` value.
 * `'unsupported'` (a simulator gap) is surfaced distinctly from a real
 * `'deny'` so Studio's traffic view can tell "the rules engine said no"
 * apart from "the rules engine couldn't tell" — but both still deny the
 * operation itself (abstain, never grant), matching the Firestore
 * simulator's posture.
 */
function denyResultFor(check: RuleCheck): 'deny' | 'unsupported' {
  return check === 'unsupported' ? 'unsupported' : 'deny';
}
import { normalizeWrite, coerceArrays } from './normalize.js';

/**
 * Listener callback shape — fires with the JSON value at the listener's
 * path, on subscribe and after every write that touches the path or any
 * of its descendants.
 *
 * `exists` mirrors `DataSnapshot.exists()`; sandboxed equivalent of the
 * SDK's "absent path → val === null && exists === false".
 */
export interface ValueListener {
  id: string;
  auth: AuthState;
  cb: (snap: ValueListenerSnapshot) => void;
  path: string;
  cancelCallback?: (error: Error) => void;
  /** Stops the client-owned live-auth registration after terminal denial. */
  onCanceled?: () => void;
  /**
   * If set, the listener is on a `query(ref, ...constraints)` rather
   * than a plain ref. The backend evaluates the spec each time the
   * subtree at `path` changes and only fires the callback when the
   * windowed result has actually changed (locked by oracle observation
   * `rtdb-modular-onvalue-with-query.json` — writes outside the window
   * do NOT fire the listener).
   */
  query?: QuerySpec;
  /**
   * Cached last-fired payload — used by the query path to skip fires
   * when the windowed result hasn't moved. Plain (non-query) listeners
   * ignore this field (they fire on any descendant write).
   */
  lastWindow?: QueryRow[];
  /**
   * Cached last-fired value for a plain (non-query) listener. RTDB's
   * SyncTree suppresses a value-listener fire when the value at the
   * listener's exact path didn't change (DB-B8) — an ancestor/descendant
   * write that leaves this path's subtree byte-identical does NOT
   * re-fire. We compare the new value against this cache and skip the
   * fire when they're deep-equal. `undefined` means "not yet fired"
   * (the initial fire always sets it, so it's defined thereafter — a
   * last value of `null` is stored as `null`, distinct from `undefined`).
   */
  lastValue?: JsonValue;
  /** Priority metadata at/below the watched path on the last delivery. */
  lastPriorityState?: string;
}

interface ValueListenerSnapshot {
  val: JsonValue;
  exists: boolean;
  key: string | null;
  /** Preserves executor order for integer-looking keys in query listeners. */
  rows?: QueryRow[];
}

/**
 * Child-event listener — fires per-child rather than per-subtree.
 * Locked by oracle observations under
 * `packages/conformance/observations/rtdb-modular/rtdb-modular-onchild*.json`:
 *
 *   - `child_added`: replays existing children on subscribe (one fire
 *     per existing key, in default priority/key order), then fires
 *     once per NEW child after subscribe.
 *   - `child_changed`: NO initial replay; fires once when an existing
 *     child's value changes. Snapshot carries the NEW value.
 *   - `child_removed`: NO initial replay; fires once when a child is
 *     deleted (via `remove` or `set(null)`). Snapshot carries the
 *     PRIOR value (the now-removed child's last value).
 *   - `child_moved`: fires when the active index changes position;
 *     plain refs use Firebase's default priority index.
 *
 * When a listener carries a {@link ChildListener.spec} (i.e. it was
 * registered on a `query(ref, ...)`), the add / change / remove events
 * are computed against the ordered, WINDOWED result (`fanOutQueryChild`):
 * a child entering the window fires `child_added`, one leaving fires
 * `child_removed`, an in-window value change fires `child_changed`.
 * `child_moved` on a query fires when its active ordered value changes and
 * carries Firebase's `previousChildName` sequence.
 */
export interface ChildListener {
  id: string;
  auth: AuthState;
  event: 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';
  path: string;
  cb: (snap: { key: string; val: JsonValue; previousChildName: string | null }) => void;
  cancelCallback?: (error: Error) => void;
  /** Stops the client-owned live-auth registration after terminal denial. */
  onCanceled?: () => void;
  /**
   * If set, the listener is on a `query(ref, ...constraints)` rather than
   * a plain ref. Child events are then computed against the ordered,
   * windowed query result instead of the raw child key-set:
   *
   *   - a child ENTERING the window emits `child_added`;
   *   - a child LEAVING the window emits `child_removed`;
   *   - an in-window value change emits `child_changed`.
   *
   * `child_moved` is emitted when an ordered value changes, with the new
   * predecessor captured from the post-write ordered window.
   */
  spec?: QuerySpec;
  /**
   * Cached last-fired ordered window for a query child listener. The diff
   * on the next write is computed against this. `undefined` for plain-ref
   * listeners (they diff the raw child key-set instead).
   */
  lastWindow?: QueryRow[];
}

/**
 * RtdbBackend — the per-`Sandbox` data plane.
 */
export class RtdbBackend {
  private readonly tree = new DataTree();
  private readonly rules = new RulesEvaluator();
  private activeRules: { rules: Record<string, unknown> } | null = null;
  private readonly valueListeners = new Set<ValueListener>();
  private readonly childListeners = new Set<ChildListener>();
  private readonly priorities = new Map<string, Exclude<Priority, null>>();
  private mutationVersion = 0;
  private readonly activeTransactionVersions: number[] = [];
  private readonly transactionMutationHistory: Array<{ version: number; paths: string[] }> = [];
  private nextId = 0;
  private resetGeneration = 0;

  /** Monotonic sandbox-reset marker consumed by client-owned connection queues. */
  get connectionResetGeneration(): number {
    return this.resetGeneration;
  }

  /** Invalidate ephemeral connection state without changing persisted data. */
  invalidateConnectionQueues(): void {
    this.resetGeneration += 1;
  }

  /**
   * Persistence change-subscribers. The sandbox persistence controller
   * registers one of these (via {@link RtdbBackend.subscribeWrites}) so any
   * tree mutation schedules a debounced flush. RTDB writes emit
   * `kind: 'service_mutation'` events, which are NOT in the controller's
   * `isPersistableEvent` set (`write`/`session_boundary`) — so the sandbox
   * event stream never triggers an RTDB flush. This subscriber channel is
   * the sole flush trigger, mirroring how auth drives its own flushes.
   */
  private readonly writeSubscribers = new Set<() => void>();

  /**
   * The owning `Sandbox`, when this backend was created through the
   * modular surface's `getDatabase(sandbox)` / `getDatabase(ctx)` path.
   * Held only to emit RTDB write activity onto the unified Studio
   * `onEvent`/`history()` stream (keystone, track T1). Optional because
   * the backend is also constructed bare in unit tests that exercise the
   * data plane directly; in that case emission is simply skipped.
   */
  private readonly sandbox?: Sandbox;

  constructor(sandbox?: Sandbox) {
    this.sandbox = sandbox;
  }

  /**
   * Emit an RTDB {@link ServiceMutationEvent} onto the sandbox's unified
   * stream. No-op when this backend has no owning sandbox (bare-test
   * construction). Best-effort + isolated — a throw must not fail the
   * write that triggered it.
   */
  private emitRtdbEvent(
    auth: AuthState,
    op: 'set' | 'update' | 'remove' | 'transaction',
    path: string,
    fields: { before?: unknown; after?: unknown; detail?: Record<string, unknown> } = {},
  ): void {
    if (!this.sandbox) return;
    try {
      emitSandboxEvent(
        this.sandbox,
        makeServiceMutationEvent({
          service: 'rtdb',
          op,
          path,
          auth,
          before: fields.before,
          after: fields.after,
          detail: fields.detail,
        }),
        { service: 'rtdb' },
      );
    } catch {
      // Observational — never let event emission break an RTDB write.
    }
  }

  private nextListenerId(): string {
    this.nextId += 1;
    return `rtdb-listener-${this.nextId.toString(36)}`;
  }

  private nextGroupId(prefix: string): string {
    this.nextId += 1;
    return `rtdb-${prefix}-${this.nextId.toString(36)}`;
  }

  getPriority(path: string): Priority {
    return this.priorities.get(joinPath(pathSegments(path))) ?? null;
  }

  private priorityForChild(path: string): (key: string) => Priority {
    const base = pathSegments(path);
    return (key) => this.getPriority(joinPath([...base, key]));
  }

  private clearPrioritiesAtOrBelow(path: string): void {
    const canonical = joinPath(pathSegments(path));
    const prefix = canonical === '/' ? '/' : `${canonical}/`;
    for (const key of this.priorities.keys()) {
      if (key === canonical || key.startsWith(prefix)) this.priorities.delete(key);
    }
  }

  private replacePriority(path: string, priority: Priority): void {
    this.clearPrioritiesAtOrBelow(path);
    if (priority !== null) this.priorities.set(joinPath(pathSegments(path)), priority);
  }

  private priorityStateAtOrBelow(path: string): string {
    const canonical = joinPath(pathSegments(path));
    const prefix = canonical === '/' ? '/' : `${canonical}/`;
    return JSON.stringify([...this.priorities]
      .filter(([key]) => key === canonical || key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b)));
  }

  private applyPriorityEffectsForUpdate(writes: Array<{ path: string; value: JsonValue }>): void {
    for (const write of writes) {
      const priority = this.getPriority(write.path);
      this.clearPrioritiesAtOrBelow(write.path);
      // Firebase update() preserves priority on the exact updated node, but
      // replacing that node's value discards priority metadata below it.
      if (write.value !== null && priority !== null) {
        this.priorities.set(joinPath(pathSegments(write.path)), priority);
      }
    }
  }

  private markMutation(paths: string | string[] = '/'): void {
    this.mutationVersion += 1;
    if (this.activeTransactionVersions.length > 0) {
      this.transactionMutationHistory.push({
        version: this.mutationVersion,
        paths: (Array.isArray(paths) ? paths : [paths]).map((path) =>
          joinPath(pathSegments(path))),
      });
    }
  }

  private hasConflictingMutationSince(version: number, path: string): boolean {
    const canonical = joinPath(pathSegments(path));
    for (const mutation of this.transactionMutationHistory) {
      if (mutation.version <= version) continue;
      if (mutation.paths.some((mutatedPath) => pathsOverlap(canonical, mutatedPath))) return true;
    }
    return false;
  }

  private releaseTransactionVersion(version: number): void {
    const index = this.activeTransactionVersions.lastIndexOf(version);
    if (index >= 0) this.activeTransactionVersions.splice(index, 1);
    if (this.activeTransactionVersions.length === 0) {
      this.transactionMutationHistory.length = 0;
      return;
    }
    const oldestActiveVersion = Math.min(...this.activeTransactionVersions);
    const firstRelevant = this.transactionMutationHistory.findIndex(
      (mutation) => mutation.version > oldestActiveVersion,
    );
    if (firstRelevant < 0) this.transactionMutationHistory.length = 0;
    else if (firstRelevant > 0) this.transactionMutationHistory.splice(0, firstRelevant);
  }

  private emitOperation(
    auth: AuthState,
    method: string,
    path: string,
    result: 'allow' | 'deny' | 'unsupported' | 'error' | 'not-applicable',
    evaluation: RuleEvaluationDetails | undefined,
    fields: {
      at?: number;
      durationMs?: number;
      origin?: 'user' | 'listener' | 'transaction' | 'batch' | 'admin' | 'system';
      request?: { data?: unknown; resourceData?: unknown; query?: unknown };
      resourceBefore?: { data: unknown; exists: boolean };
      resourceAfter?: { data: unknown; exists: boolean };
      groupId?: string;
      groupKind?: 'batch' | 'transaction';
      triggeredBy?: { method: string; path?: string };
      detail?: Record<string, unknown>;
    } = {},
  ): void {
    if (!this.sandbox) return;
    try {
      emitSandboxEvent(
        this.sandbox,
        makeSandboxOperationEvent({
          service: 'rtdb',
          method,
          path: canonicalPath(path),
          auth,
          result,
          origin: fields.origin ?? 'user',
          durationMs: fields.durationMs,
          reasons: evaluation?.reasons,
          rules: evaluation
            ? {
                engine: 'rtdb',
                matchedPath: evaluation.matchedPath,
                matchedRule: evaluation.matchedRule,
                pathVariableBindings: evaluation.pathVariableBindings,
                reason: evaluation.reason,
                errorCode: evaluation.errorCode,
              }
            : undefined,
          request: fields.request,
          resourceBefore: fields.resourceBefore,
          resourceAfter: fields.resourceAfter,
          groupId: fields.groupId,
          groupKind: fields.groupKind,
          triggeredBy: fields.triggeredBy,
          detail: fields.detail,
          at: fields.at,
        }),
        { service: 'rtdb' },
      );
    } catch {
      // Observational — never let telemetry break RTDB semantics.
    }
  }

  private emitCommit(
    auth: AuthState,
    method: string,
    path: string,
    fields: {
      data?: unknown;
      priorState?: unknown;
      nextState?: unknown;
      groupId?: string;
      groupKind?: 'batch' | 'transaction';
      replay?: { requestTime?: number; autoId?: string; sentinels?: Array<{ field: string; kind: string }> };
      detail?: Record<string, unknown>;
    } = {},
  ): void {
    if (!this.sandbox) return;
    try {
      emitSandboxEvent(
        this.sandbox,
        makeSandboxCommitEvent({
          service: 'rtdb',
          method,
          path: canonicalPath(path),
          auth,
          data: fields.data,
          priorState: fields.priorState,
          nextState: fields.nextState,
          groupId: fields.groupId,
          groupKind: fields.groupKind,
          replay: fields.replay,
          detail: fields.detail,
        }),
        { service: 'rtdb' },
      );
    } catch {
      // Observational — never let telemetry break RTDB semantics.
    }
  }

  private emitListener(
    phase: 'attach' | 'detach' | 'delivery' | 'suppressed' | 'errored',
    listener: Pick<ValueListener | ChildListener, 'id' | 'path'>,
    auth: AuthState,
    fields: {
      event?: ChildListener['event'] | 'value';
      result?: 'allow' | 'deny' | 'unsupported' | 'error';
      size?: number;
      sample?: unknown;
      reason?: string;
      error?: { code?: string; message: string; reasons?: string[] };
      triggeredBy?: { method: string; path?: string };
      detail?: Record<string, unknown>;
    } = {},
  ): void {
    if (!this.sandbox) return;
    try {
      emitSandboxEvent(
        this.sandbox,
        makeSandboxListenerEvent({
          service: 'rtdb',
          phase,
          listenerId: listener.id,
          target: {
            kind: fields.event ?? 'value',
            path: canonicalPath(listener.path),
          },
          auth,
          result: fields.result,
          size: fields.size,
          sample: fields.sample,
          reason: fields.reason,
          error: fields.error,
          triggeredBy: fields.triggeredBy,
          detail: fields.detail,
        }),
        { service: 'rtdb' },
      );
    } catch {
      // Observational — never let telemetry break RTDB semantics.
    }
  }

  // ─── Admin-plane (rule-bypass) operations ───────────────────────────
  //
  // Used by the `sandbox.setData` / `sandbox.snapshotState` test
  // helpers exported on the modular SDK. Don't go through the rule
  // engine.

  setData(seed: Record<string, JsonValue>): void {
    this.tree.restore({});
    this.priorities.clear();
    // Seed each path individually so the tree's prior-trim semantics
    // apply consistently. For a flat seed of nested data we'd just
    // restore(); but per-path seeding lets `setData({'/a/b': 1})` work
    // when the user supplies dotted-out paths.
    for (const [path, value] of Object.entries(seed)) {
      // Resolve sentinels + normalize in seed too — keeps the seed API
      // symmetric with the user-plane writes (array coercion, pruning).
      const resolved = normalizeWrite(
        resolveSentinels(value, Date.now()) as JsonValue,
        path === '/' ? '' : path,
      );
      this.tree.write(path, resolved);
    }
    this.markMutation('/');
    this.notifyWrite();
  }

  setRules(rulesJson: { rules: Record<string, unknown> } | null): void {
    this.rules.setRules(rulesJson);
    this.activeRules = rulesJson === null ? null : structuredClone(rulesJson);
    this.cancelDeniedListeners();
  }

  private cancelDeniedListeners(): void {
    const mockData = this.tree.snapshot() as Record<string, unknown>;
    const deniedValues: ValueListener[] = [];
    for (const listener of [...this.valueListeners]) {
      const evaluation = this.rules.evaluate('read', listener.path, {
        auth: listener.auth,
        mockData,
      });
      if (evaluation.check === 'allow') continue;
      this.valueListeners.delete(listener);
      deniedValues.push(listener);
    }
    const deniedChildren: ChildListener[] = [];
    for (const listener of [...this.childListeners]) {
      const evaluation = this.rules.evaluate('read', listener.path, {
        auth: listener.auth,
        mockData,
      });
      if (evaluation.check === 'allow') continue;
      this.childListeners.delete(listener);
      deniedChildren.push(listener);
    }
    // Terminalize every denied registration before invoking any user code.
    // Cancellation callbacks are isolated just like data callbacks: one
    // throw must not interrupt revocation of the remaining listeners.
    for (const listener of [...deniedValues, ...deniedChildren]) {
      try { listener.onCanceled?.(); } catch { /* internal teardown is isolated */ }
      try {
        listener.cancelCallback?.(listenerPermissionDenied(listener.path));
      } catch {
        // Firebase does not let a user cancellation callback break the
        // listener-revocation pass.
      }
    }
  }

  getActiveRules(): { rules: Record<string, unknown> } | null {
    return this.activeRules === null ? null : structuredClone(this.activeRules);
  }

  snapshotState(): JsonValue {
    return this.tree.snapshot();
  }

  adminGet(path: string): JsonValue {
    const value = this.tree.read(path);
    this.emitOperation(null, 'get', path, 'not-applicable', undefined, {
      origin: 'admin',
      resourceBefore: { data: value, exists: value !== null },
    });
    return value;
  }

  adminGetQuery(path: string, spec: QuerySpec): QueryRow[] {
    const rows = executeQuery(this.tree.read(path), spec, this.priorityForChild(path));
    this.emitOperation(null, 'get', path, 'not-applicable', undefined, {
      origin: 'admin',
      request: { query: spec },
      resourceBefore: { data: rowsToVal(rows), exists: rows.length > 0 },
    });
    return rows;
  }

  adminSet(path: string, value: JsonValue): void {
    this.adminSetWithPriority(path, value, null);
  }

  adminSetWithPriority(path: string, value: JsonValue, priority: Priority): void {
    validatePriority(priority);
    const now = Date.now();
    const before = this.tree.read(path);
    const resolved = normalizeWrite(
      resolveSentinels(value, now, before) as JsonValue,
      path === '/' ? '' : path,
    );
    this.emitOperation(null, resolved === null ? 'remove' : 'set', path, 'not-applicable', undefined, {
      origin: 'admin',
      request: { data: value, resourceData: value },
      resourceBefore: { data: before, exists: before !== null },
      resourceAfter: { data: resolved, exists: resolved !== null },
    });
    const priors = this.snapshotChildListenerParents();
    const priorPriorityState = this.priorityStateAtOrBelow(path);
    this.tree.write(path, resolved);
    this.replacePriority(path, resolved === null ? null : priority);
    const priorityChanged = priorPriorityState !== this.priorityStateAtOrBelow(path);
    this.markMutation(path);
    this.fanOut([path]);
    this.fanOutChildren(priors, priorityChanged ? path : undefined);
    const after = this.tree.read(path);
    const method = after === null ? 'remove' : 'set';
    this.emitCommit(null, method, path, {
      data: value,
      priorState: before,
      nextState: after,
      replay: { requestTime: now },
      detail: { admin: true },
    });
    this.notifyWrite();
  }

  adminUpdate(path: string, patch: Record<string, JsonValue>): void {
    const now = Date.now();
    const before = this.tree.read(path);
    const isMultiPath = Object.keys(patch).some((k) => k.includes('/'));
    const priors = this.snapshotChildListenerParents();
    if (isMultiPath) {
      const expanded: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(patch)) {
        const absPath = joinPath([...pathSegments(path), ...pathSegments(k)]);
        expanded[absPath] = normalizeWrite(
          resolveSentinels(v, now, this.tree.read(absPath)) as JsonValue,
          absPath,
        );
      }
      this.emitOperation(null, 'update', path, 'not-applicable', undefined, {
        origin: 'admin',
        request: { data: patch, resourceData: patch },
        resourceBefore: { data: before, exists: before !== null },
        detail: { admin: true, multiPath: true, paths: Object.keys(expanded) },
      });
      this.tree.multiUpdate(expanded);
      this.applyPriorityEffectsForUpdate(Object.entries(expanded).map(([writePath, value]) => ({ path: writePath, value })));
      this.markMutation(Object.keys(expanded));
      this.fanOut(Object.keys(expanded));
      this.fanOutChildren(priors);
      const after = this.tree.read(path);
      this.emitCommit(null, 'update', path, {
        data: patch,
        priorState: before,
        nextState: after,
        replay: { requestTime: now },
        detail: { admin: true, multiPath: true, paths: Object.keys(expanded) },
      });
      this.notifyWrite();
      return;
    }

    const resolvedPatch: Record<string, JsonValue> = {};
    const touched: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const sub = joinPath([...pathSegments(path), ...pathSegments(k)]);
      touched.push(sub);
      resolvedPatch[k] = normalizeWrite(
        resolveSentinels(v, now, this.tree.read(sub)) as JsonValue,
        sub,
      );
    }
    this.emitOperation(null, 'update', path, 'not-applicable', undefined, {
      origin: 'admin',
      request: { data: patch, resourceData: patch },
      resourceBefore: { data: before, exists: before !== null },
      detail: { admin: true, multiPath: false, keys: Object.keys(resolvedPatch) },
    });
    this.tree.shallowUpdate(path, resolvedPatch);
    this.applyPriorityEffectsForUpdate(Object.entries(resolvedPatch).map(([key, value]) => ({
      path: joinPath([...pathSegments(path), ...pathSegments(key)]),
      value,
    })));
    this.markMutation(touched);
    this.fanOut(touched);
    this.fanOutChildren(priors);
    const after = this.tree.read(path);
    this.emitCommit(null, 'update', path, {
      data: patch,
      priorState: before,
      nextState: after,
      replay: { requestTime: now },
      detail: { admin: true, multiPath: false, keys: Object.keys(resolvedPatch) },
    });
    this.notifyWrite();
  }

  adminRemove(path: string): void {
    this.adminSet(path, null);
  }

  adminSetPriority(path: string, priority: Priority): void {
    validatePriority(priority);
    if (this.tree.read(path) === null) return;
    const priors = this.snapshotChildListenerParents();
    const previousPriority = this.getPriority(path);
    if (priority === null) this.priorities.delete(joinPath(pathSegments(path)));
    else this.priorities.set(joinPath(pathSegments(path)), priority);
    this.markMutation(path);
    const priorityChanged = previousPriority !== priority;
    if (priorityChanged) this.fanOut([path]);
    this.fanOutChildren(priors, priorityChanged ? path : undefined);
    this.notifyWrite();
  }

  // ─── User-plane (rule-gated) operations ────────────────────────────

  get(auth: AuthState, path: string): JsonValue {
    const at = Date.now();
    const before = this.tree.read(path);
    const evaluation = this.rules.evaluate('read', path === '/' ? '/' : path, {
      auth,
      mockData: this.tree.snapshot() as Record<string, unknown>,
    });
    if (evaluation.check !== 'allow') {
      this.emitOperation(auth, 'get', path, denyResultFor(evaluation.check), evaluation, {
        at,
        durationMs: Date.now() - at,
        resourceBefore: { data: before, exists: before !== null },
      });
      throw permissionDenied();
    }
    this.emitOperation(auth, 'get', path, 'allow', evaluation, {
      at,
      durationMs: Date.now() - at,
      resourceBefore: { data: before, exists: before !== null },
    });
    // Return the stored (integer-keyed) shape. Array coercion (DB-B2) is
    // a `DataSnapshot.val()`-render concern applied by the snapshot
    // wrapper — structural ops (`forEach`/`child`/`size`) walk the node.
    return this.tree.read(path);
  }

  /**
   * `set(path, value)` — full overwrite at the path. `null` deletes the
   * subtree (sandbox match for the RTDB invariant
   * `remove(ref) === set(ref, null)`).
   */
  set(auth: AuthState, path: string, value: JsonValue): void {
    this.setInternal(auth, path, value, 'set', null);
  }

  setWithPriority(auth: AuthState, path: string, value: JsonValue, priority: Priority): void {
    validatePriority(priority);
    this.setInternal(auth, path, value, 'set', priority);
  }

  /** Shared `set`/`remove` write path. `op` selects the emitted event
   *  label so a `remove` (which is `set(_, null)`) surfaces as `remove`
   *  rather than `set` on the Studio stream. */
  private setInternal(
    auth: AuthState,
    path: string,
    value: JsonValue,
    op: 'set' | 'remove',
    priority: Priority,
  ): void {
    const now = Date.now();
    // Pass the current value at the path so `increment()` sentinels
    // resolve against the field's prior value (DB-GAP).
    const resolved0 = resolveSentinels(value, now, this.tree.read(path)) as JsonValue;
    // Write-boundary normalization (DB-B1/B2/B3): validate keys + reject
    // `undefined`/non-finite, coerce arrays → integer-keyed objects, prune
    // null/empty subtrees. An object that prunes to nothing is a delete
    // (`set(ref, {})` === `remove(ref)`).
    const resolved = normalizeWrite(resolved0, path === '/' ? '' : path);
    const before = this.tree.read(path);
    const at = Date.now();
    const evaluation = this.rules.evaluate('write', path === '/' ? '/' : path, {
      auth,
      mockData: this.tree.snapshot() as Record<string, unknown>,
      newData: resolved,
    });
    const resourceBefore = { data: before, exists: before !== null };
    const resourceAfter = { data: resolved, exists: resolved !== null };
    if (evaluation.check !== 'allow') {
      this.emitOperation(auth, op, path, denyResultFor(evaluation.check), evaluation, {
        at,
        durationMs: Date.now() - at,
        request: { data: value, resourceData: value },
        resourceBefore,
        resourceAfter,
      });
      throw permissionDenied();
    }
    this.emitOperation(auth, op, path, 'allow', evaluation, {
      at,
      durationMs: Date.now() - at,
      request: { data: value, resourceData: value },
      resourceBefore,
      resourceAfter,
    });
    const priors = this.snapshotChildListenerParents();
    const priorPriorityState = this.priorityStateAtOrBelow(path);
    this.tree.write(path, resolved);
    this.replacePriority(path, resolved === null ? null : priority);
    const priorityChanged = priorPriorityState !== this.priorityStateAtOrBelow(path);
    this.markMutation(path);
    this.fanOut([path]);
    this.fanOutChildren(priors, priorityChanged ? path : undefined);
    // A write that pruned to nothing (`set(ref, null)` / `set(ref, {})`)
    // is semantically a remove; label it as such even if it arrived via
    // `set`. `after` is the post-write value at the path (`null` when the
    // subtree was deleted).
    const after = this.tree.read(path);
    const effectiveOp = after === null ? 'remove' : op;
    this.emitCommit(auth, effectiveOp, path, {
      data: value,
      priorState: before,
      nextState: after,
      replay: { requestTime: now },
    });
    this.emitRtdbEvent(auth, effectiveOp, canonicalPath(path), { before, after });
    this.notifyWrite();
  }

  remove(auth: AuthState, path: string): void {
    this.setInternal(auth, path, null, 'remove', null);
  }

  setPriority(auth: AuthState, path: string, priority: Priority): void {
    validatePriority(priority);
    const current = this.tree.read(path);
    const at = Date.now();
    const evaluation = this.rules.evaluate('write', path === '/' ? '/' : path, {
      auth,
      mockData: this.tree.snapshot() as Record<string, unknown>,
      newData: current,
    });
    if (evaluation.check !== 'allow') {
      this.emitOperation(auth, 'setPriority', path, denyResultFor(evaluation.check), evaluation, {
        at,
        durationMs: Date.now() - at,
        request: { data: priority },
        resourceBefore: { data: current, exists: current !== null },
      });
      throw permissionDenied();
    }
    if (current === null) return;
    const priors = this.snapshotChildListenerParents();
    const previousPriority = this.getPriority(path);
    if (priority === null) this.priorities.delete(joinPath(pathSegments(path)));
    else this.priorities.set(joinPath(pathSegments(path)), priority);
    this.markMutation(path);
    const priorityChanged = previousPriority !== priority;
    if (priorityChanged) this.fanOut([path]);
    this.fanOutChildren(priors, priorityChanged ? path : undefined);
    this.notifyWrite();
  }

  /** Rule-only registration check for an onDisconnect set/remove. */
  validateSet(auth: AuthState, path: string, value: unknown): void {
    const resolved = normalizeWrite(
      resolveSentinels(value, Date.now(), this.tree.read(path)) as JsonValue,
      path === '/' ? '' : path,
    );
    const evaluation = this.rules.evaluate('write', path === '/' ? '/' : path, {
      auth,
      mockData: this.tree.snapshot() as Record<string, unknown>,
      newData: resolved,
    });
    if (evaluation.check !== 'allow') throw permissionDenied();
  }

  /** Rule-only registration check for an onDisconnect update. */
  validateUpdate(auth: AuthState, path: string, patch: Record<string, unknown>): void {
    const mock = this.tree.snapshot() as Record<string, unknown>;
    const resolved = Object.entries(patch).map(([key, value]) => {
      const absolute = joinPath([...pathSegments(path), ...pathSegments(key)]);
      return {
        path: absolute,
        value: normalizeWrite(
          resolveSentinels(value, Date.now(), this.tree.read(absolute)) as JsonValue,
          absolute,
        ),
      };
    });
    for (const entry of resolved) {
      const evaluation = this.rules.evaluate('write', entry.path, {
        auth,
        mockData: mock,
        newData: entry.value,
        ...(resolved.length > 1 ? { updates: resolved } : {}),
      });
      if (evaluation.check !== 'allow') throw permissionDenied();
    }
  }

  /**
   * `update(path, patch)` — multi-path atomic update when keys are
   * `/`-prefixed and `path === '/'`; otherwise a shallow merge at the
   * named path. Matches `firebase/database`'s discrimination: an
   * `update(rootRef, { '/users/a/x': 1, '/users/b/y': 2 })` fans out
   * to both paths atomically, while `update(usersRef, { name: 'A' })`
   * shallow-merges into `/users`.
   */
  update(auth: AuthState, path: string, patch: Record<string, JsonValue>): void {
    const now = Date.now();
    const isMultiPath = Object.keys(patch).some((k) => k.includes('/'));
    if (isMultiPath) {
      const groupId = this.nextGroupId('update');
      // Each key is treated as a path relative to `path`. Resolve
      // sentinels per-leaf so a key whose value contains a
      // `serverTimestamp()` lands as a number.
      const expanded: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(patch)) {
        const absSegs = [...pathSegments(path), ...pathSegments(k)];
        const absPath = joinPath(absSegs);
        expanded[absPath] = normalizeWrite(
          resolveSentinels(v, now, this.tree.read(absPath)) as JsonValue,
          absPath,
        );
      }
      // Check every path under the rules engine. ANY denial fails the
      // entire update — the multi-path atomicity contract.
      //
      // A multi-path update is atomic: every path's `.write`/`.validate`
      // rules must see `newData` reflecting the ENTIRE projected post-update
      // tree (all paths applied together), not just its own leaf. Pass the
      // full update set so the simulator builds one shared projection — a
      // rule on `/a` that reads a sibling `/b` written in the same update
      // must see `/b`'s new value.
      const mock = this.tree.snapshot() as Record<string, unknown>;
      const updates = Object.entries(expanded).map(([absPath, value]) => ({
        path: absPath,
        value,
      }));
      for (const [absPath, value] of Object.entries(expanded)) {
        const at = Date.now();
        const before = this.tree.read(absPath);
        const evaluation = this.rules.evaluate('write', absPath, {
          auth,
          mockData: mock,
          newData: value,
          updates,
        });
        const common = {
          at,
          durationMs: Date.now() - at,
          origin: 'batch' as const,
          request: { data: value, resourceData: value },
          resourceBefore: { data: before, exists: before !== null },
          resourceAfter: { data: value, exists: value !== null },
          groupId,
          groupKind: 'batch' as const,
          detail: { multiPath: true, rootPath: canonicalPath(path) },
        };
        if (evaluation.check !== 'allow') {
          this.emitOperation(auth, 'update', absPath, denyResultFor(evaluation.check), evaluation, common);
          throw permissionDenied();
        }
        this.emitOperation(auth, 'update', absPath, 'allow', evaluation, common);
      }
      // Apply atomically via the tree's overlap-checked multi-write.
      const beforeRoot = this.tree.read(path);
      const priors = this.snapshotChildListenerParents();
      this.tree.multiUpdate(expanded);
      this.applyPriorityEffectsForUpdate(Object.entries(expanded).map(([writePath, value]) => ({ path: writePath, value })));
      this.markMutation(Object.keys(expanded));
      this.fanOut(Object.keys(expanded));
      this.fanOutChildren(priors);
      const afterRoot = this.tree.read(path);
      this.emitCommit(auth, 'update', path, {
        data: patch,
        priorState: beforeRoot,
        nextState: afterRoot,
        groupId,
        groupKind: 'batch',
        replay: { requestTime: now },
        detail: { multiPath: true, paths: Object.keys(expanded) },
      });
      this.emitRtdbEvent(auth, 'update', canonicalPath(path), {
        after: expanded,
        detail: { multiPath: true, paths: Object.keys(expanded) },
      });
      this.notifyWrite();
      return;
    }
    // Shallow merge mode. Each top-level key of `patch` replaces the
    // key at `<path>/<key>`. `null` deletes.
    const resolvedPatch: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(patch)) {
      const sub = joinPath([...pathSegments(path), ...pathSegments(k)]);
      resolvedPatch[k] = normalizeWrite(
        resolveSentinels(v, now, this.tree.read(sub)) as JsonValue,
        sub,
      );
    }
    const mock = this.tree.snapshot() as Record<string, unknown>;
    const touched: string[] = [];
    const groupId = this.nextGroupId('update');
    for (const [k, v] of Object.entries(resolvedPatch)) {
      const sub = joinPath([...pathSegments(path), ...pathSegments(k)]);
      touched.push(sub);
      const at = Date.now();
      const before = this.tree.read(sub);
      const evaluation = this.rules.evaluate('write', sub, {
        auth,
        mockData: mock,
        newData: v,
      });
      const common = {
        at,
        durationMs: Date.now() - at,
        origin: 'batch' as const,
        request: { data: v, resourceData: v },
        resourceBefore: { data: before, exists: before !== null },
        resourceAfter: { data: v, exists: v !== null },
        groupId,
        groupKind: 'batch' as const,
        detail: { multiPath: false, rootPath: canonicalPath(path), key: k },
      };
      if (evaluation.check !== 'allow') {
        this.emitOperation(auth, 'update', sub, denyResultFor(evaluation.check), evaluation, common);
        throw permissionDenied();
      }
      this.emitOperation(auth, 'update', sub, 'allow', evaluation, common);
    }
    const beforeRoot = this.tree.read(path);
    const priors = this.snapshotChildListenerParents();
    this.tree.shallowUpdate(path, resolvedPatch);
    this.applyPriorityEffectsForUpdate(Object.entries(resolvedPatch).map(([key, value]) => ({
      path: joinPath([...pathSegments(path), ...pathSegments(key)]),
      value,
    })));
    this.markMutation(touched);
    this.fanOut(touched);
    this.fanOutChildren(priors);
    const afterRoot = this.tree.read(path);
    this.emitCommit(auth, 'update', path, {
      data: patch,
      priorState: beforeRoot,
      nextState: afterRoot,
      groupId,
      groupKind: 'batch',
      replay: { requestTime: now },
      detail: { multiPath: false, keys: Object.keys(resolvedPatch) },
    });
    this.emitRtdbEvent(auth, 'update', canonicalPath(path), {
      after: resolvedPatch,
      detail: { multiPath: false, keys: Object.keys(resolvedPatch) },
    });
    this.notifyWrite();
  }

  // Note: `push()` is implemented entirely on the modular surface
  // (`modular.ts`) — the key is minted client-side via {@link mintKey}
  // (no rule check) so it's available synchronously even under a denying
  // rule (DB-B7), and the optional value write is deferred onto the
  // returned ThenableReference's promise via the normal `set` path.

  // ─── Listeners ─────────────────────────────────────────────────────

  /**
   * Subscribe to `onValue`. Fires immediately with the current value
   * (or `{ val: null, exists: false }` for an absent path — locked by
   * the prod SDK's behavior), then on every write that touches `path`
   * or any descendant.
   *
   * Returns an unsubscribe.
   */
  onValue(
    auth: AuthState,
    path: string,
    cb: (snap: ValueListenerSnapshot) => void,
    query?: QuerySpec,
    cancelCallback?: (error: Error) => void,
    onCanceled?: () => void,
  ): () => void {
    // Rules check at subscribe time. A denied subscribe never gets
    // the initial fire — matches production where the listener errors
    // out before any callback.
    const at = Date.now();
    const evaluation = this.rules.evaluate('read', path === '/' ? '/' : path, {
      auth,
      mockData: this.tree.snapshot() as Record<string, unknown>,
    });
    if (evaluation.check !== 'allow') {
      this.emitOperation(auth, 'listen', path, denyResultFor(evaluation.check), evaluation, {
        at,
        durationMs: Date.now() - at,
        request: query ? { query } : undefined,
        origin: 'listener',
      });
      this.emitListener('errored', { id: this.nextListenerId(), path }, auth, {
        event: 'value',
        result: 'deny',
        error: {
          code: 'PERMISSION_DENIED',
          message: 'PERMISSION_DENIED: Permission denied',
          reasons: evaluation.reasons,
        },
      });
      if (cancelCallback) {
        queueMicrotask(() => {
          onCanceled?.();
          cancelCallback(listenerPermissionDenied(path));
        });
        return () => {};
      }
      throw permissionDenied();
    }
    return this.attachValueListener(auth, path, cb, query, {
      origin: 'listener',
      result: 'allow',
      evaluation,
      at,
    }, cancelCallback, onCanceled);
  }

  /**
   * Rules-BYPASS `onValue` — the listen-plane sibling of {@link adminGet} /
   * {@link adminSet}. Cloud Functions RTDB triggers read via firebase-admin,
   * which bypasses security rules; the sandbox relays that trigger
   * subscription through the worker host's `{ mode: 'admin' }` lens
   * ({@link getAdminDatabase}), and this is where that lens actually skips the
   * read-rule gate. Without it an auth-gated `.read` on the watched path
   * (or the RTDB root default-deny above it) would `PERMISSION_DENIED` the
   * trigger subscription at startup — see issue #401.
   *
   * The admin flag lives ONLY on server-minted admin handles; it is never
   * derived from anything a page peer controls, so a page's `onValue` still
   * routes through the rule-gated {@link onValue} above.
   */
  adminOnValue(
    path: string,
    cb: (snap: ValueListenerSnapshot) => void,
    query?: QuerySpec,
  ): () => void {
    return this.attachValueListener(null, path, cb, query, {
      origin: 'admin',
      result: 'not-applicable',
      evaluation: undefined,
      at: Date.now(),
    });
  }

  /**
   * Register a value listener AFTER any read-rule gate and run its initial
   * fire. Shared by the rule-gated {@link onValue} and the rules-bypass
   * {@link adminOnValue} so the fan-out registration, initial snapshot and
   * emitted operation/listener events stay byte-identical across both paths —
   * the only difference is whether the read rule was evaluated first.
   */
  private attachValueListener(
    auth: AuthState,
    path: string,
    cb: (snap: ValueListenerSnapshot) => void,
    query: QuerySpec | undefined,
    provenance: {
      origin: 'listener' | 'admin';
      result: 'allow' | 'not-applicable';
      evaluation: RuleEvaluationDetails | undefined;
      at: number;
    },
    cancelCallback?: (error: Error) => void,
    onCanceled?: () => void,
  ): () => void {
    const { at } = provenance;
    const listenerId = this.nextListenerId();
    this.emitOperation(auth, 'listen', path, provenance.result, provenance.evaluation, {
      at,
      durationMs: Date.now() - at,
      request: query ? { query } : undefined,
      origin: provenance.origin,
    });
    const listener: ValueListener = {
      id: listenerId,
      auth,
      cb,
      path,
      query,
      cancelCallback,
      onCanceled,
    };
    this.valueListeners.add(listener);
    this.emitListener('attach', listener, auth, {
      event: 'value',
      result: 'allow',
      detail: query ? { query } : undefined,
    });
    // Initial fire — for queries we record the initial window so the
    // diff check on the next write knows what "the previous result"
    // was. For plain listeners we just feed the path snapshot.
    if (query) {
      const initialWindow = executeQuery(this.tree.read(path), query, this.priorityForChild(path));
      listener.lastWindow = initialWindow;
      const snap = {
        val: rowsToVal(initialWindow),
        exists: initialWindow.length > 0,
        key: this.keyForPath(path),
        rows: initialWindow,
      };
      try {
        cb(snap);
        this.emitListener('delivery', listener, auth, {
          event: 'value',
          size: initialWindow.length,
          sample: snap.val,
          detail: { initial: true, query: true },
        });
      } catch (e) {
        this.emitListener('errored', listener, auth, {
          event: 'value',
          result: 'error',
          error: { message: e instanceof Error ? e.message : String(e) },
          detail: { initial: true, query: true },
        });
      }
    } else {
      const snap = this.makeSnap(path);
      // Record the initial value so a subsequent no-change write is
      // suppressed (DB-B8).
      listener.lastValue = snap.val;
      listener.lastPriorityState = this.priorityStateAtOrBelow(path);
      try {
        cb(snap);
        this.emitListener('delivery', listener, auth, {
          event: 'value',
          size: snap.exists ? 1 : 0,
          sample: snap.val,
          detail: { initial: true },
        });
      } catch (e) {
        this.emitListener('errored', listener, auth, {
          event: 'value',
          result: 'error',
          error: { message: e instanceof Error ? e.message : String(e) },
          detail: { initial: true },
        });
      }
    }
    return () => {
      this.valueListeners.delete(listener);
      this.emitListener('detach', listener, auth, { event: 'value' });
    };
  }

  /**
   * One-shot `get` against a query — evaluates the constraint chain
   * against the current tree snapshot. Same rules check as plain `get`
   * (the read is at the query's root path; per-child rule evaluation
   * isn't modeled here — RTDB itself rejects queries that span
   * children with mixed read permissions).
   */
  getQuery(auth: AuthState, path: string, spec: QuerySpec): QueryRow[] {
    const at = Date.now();
    const evaluation = this.rules.evaluate('read', path === '/' ? '/' : path, {
      auth,
      mockData: this.tree.snapshot() as Record<string, unknown>,
    });
    if (evaluation.check !== 'allow') {
      this.emitOperation(auth, 'get', path, denyResultFor(evaluation.check), evaluation, {
        at,
        durationMs: Date.now() - at,
        request: { query: spec },
      });
      throw permissionDenied();
    }
    const rows = executeQuery(this.tree.read(path), spec, this.priorityForChild(path));
    this.emitOperation(auth, 'get', path, 'allow', evaluation, {
      at,
      durationMs: Date.now() - at,
      request: { query: spec },
      resourceBefore: { data: rowsToVal(rows), exists: rows.length > 0 },
    });
    return rows;
  }

  /** The last segment of `path`, or `null` for root. Mirrors
   *  `DataSnapshot.key`. */
  private keyForPath(path: string): string | null {
    const segs = pathSegments(path);
    return segs.length === 0 ? null : segs[segs.length - 1]!;
  }

  /**
   * Compute the listener payload for `path` against the current tree.
   * `key` is the last segment of the path, or `null` for root —
   * matches `DataSnapshot.key`.
   */
  private makeSnap(path: string): { val: JsonValue; exists: boolean; key: string | null } {
    const val = this.tree.read(path);
    const exists = val !== null;
    const segs = pathSegments(path);
    const key = segs.length === 0 ? null : segs[segs.length - 1]!;
    return { val, exists, key };
  }

  /**
   * Fan out `value` listeners after a batch of paths were written.
   * Fires every listener whose path either equals one of the touched
   * paths or is an ancestor/descendant of any (the listener observes
   * the subtree it's watching, so any descendant write triggers).
   */
  private fanOut(touched: string[]): void {
    if (this.valueListeners.size === 0) return;
    const touchedSet = touched.map((p) => joinPath(pathSegments(p)));
    for (const listener of this.valueListeners) {
      const lp = joinPath(pathSegments(listener.path));
      const subtreeTouched = touchedSet.some((tp) => {
        if (tp === lp) return true;
        const lpp = lp === '/' ? '/' : lp + '/';
        const tpp = tp === '/' ? '/' : tp + '/';
        // Listener watches root: every write fires it.
        if (lp === '/') return true;
        // Touched is a descendant of the listener's path → fires.
        if (tp.startsWith(lpp)) return true;
        // Touched is an ancestor of the listener's path → also fires
        // (the listener's subtree might be different now).
        if (lp.startsWith(tpp)) return true;
        return false;
      });
      if (!subtreeTouched) continue;
      if (listener.query) {
        // Query listener: only fire if the windowed result changed.
        // Locked by oracle observation
        // `rtdb-modular-onvalue-with-query.json` — a write OUTSIDE the
        // window doesn't fire the query listener.
        const nextWindow = executeQuery(
          this.tree.read(listener.path),
          listener.query,
          this.priorityForChild(listener.path),
        );
        if (windowsEqual(listener.lastWindow ?? [], nextWindow)) {
          this.emitListener('suppressed', listener, listener.auth, {
            event: 'value',
            reason: 'no-op',
            detail: { query: true },
          });
          continue;
        }
        listener.lastWindow = nextWindow;
        const snap = {
          val: rowsToVal(nextWindow),
          exists: nextWindow.length > 0,
          key: this.keyForPath(listener.path),
          rows: nextWindow,
        };
        this.emitListener('delivery', listener, listener.auth, {
          event: 'value',
          size: nextWindow.length,
          sample: snap.val,
          detail: { query: true },
        });
        try {
          listener.cb(snap);
        } catch (e) {
          this.emitListener('errored', listener, listener.auth, {
            event: 'value',
            result: 'error',
            error: { message: e instanceof Error ? e.message : String(e) },
            detail: { query: true },
          });
          // Swallow — see plain-listener branch below.
        }
        continue;
      }
      // Plain listener: suppress the fire when the value at the
      // listener's exact path is byte-identical to the last fired value
      // (DB-B8). An ancestor/descendant write that leaves this subtree
      // unchanged must NOT re-fire — RTDB's SyncTree dedups no-change.
      const snap = this.makeSnap(listener.path);
      const last = listener.lastValue;
      const priorityState = this.priorityStateAtOrBelow(listener.path);
      if (last !== undefined && jsonValuesEqual(last, snap.val)
        && listener.lastPriorityState === priorityState) {
        this.emitListener('suppressed', listener, listener.auth, {
          event: 'value',
          reason: 'no-op',
        });
        continue;
      }
      listener.lastValue = snap.val;
      listener.lastPriorityState = priorityState;
      this.emitListener('delivery', listener, listener.auth, {
        event: 'value',
        size: snap.exists ? 1 : 0,
        sample: snap.val,
      });
      try {
        listener.cb(snap);
      } catch (e) {
        this.emitListener('errored', listener, listener.auth, {
          event: 'value',
          result: 'error',
          error: { message: e instanceof Error ? e.message : String(e) },
        });
        // Swallow — matches `firebase/database` which doesn't let
        // one observer's throw block another. The faulty listener
        // is the caller's problem.
      }
    }
  }

  /**
   * `runTransaction(path, updateFn, options?)` — RTDB-flavored atomic
   * read-modify-write. The contract mirrors `firebase/database`'s
   * modular `runTransaction`:
   *
   *   - Read the current value at `path`.
   *   - Call `updateFn(currentValue)`.
   *     - `currentValue` is `null` for an absent path (oracle:
   *       `rtdb-modular-runtransaction-current-value-arg.json` →
   *       `missingArgs[0].isNull === true`).
   *   - If `updateFn` returns `undefined` → **abort**: no write happens,
   *     resolves `{ committed: false, snapshot }` where the snapshot
   *     reflects the pre-transaction value (oracle:
   *     `rtdb-modular-runtransaction-abort-undefined.json` → `committed:
   *     false, snapVal: null, afterValOnServer: 100`).
   *   - If `updateFn` returns any defined value → run the write under
   *     the current identity's rules; on allow, commit and resolve
   *     `{ committed: true, snapshot }` with the new value. On deny,
   *     throw the RTDB-transaction error shape (oracle:
   *     `rtdb-modular-runtransaction-on-rules-denied-path.json` →
   *     `threw: true, message: 'permission_denied', code: null,
   *     constructorName: 'Error'`).
   *
   * Re-entrant competing writes from another Database client invalidate the
   * read and retry the update function, up to 25 attempts. The sandbox
   * doesn't speculatively call `updateFn` with `null` first
   * for a seeded path (prod does — second invocation with the server
   * value); our contract is the SIMPLEST observable: one invocation
   * with the actual current value.
   *
   * `applyLocally` semantics: when omitted or `true`, the in-flight
   * (post-update-fn, pre-commit) value fans out to listeners as an
   * optimistic fire. With `false`, no listener fire until commit. The
   * difference is invisible in a single-client harness with a
   * synchronous commit path; we still respect the flag so consumers can
   * tune intermediate-fire counts under custom assertions.
   *
   * Returns a payload the modular surface wraps in a `DataSnapshot`
   * shape — the backend stays snapshot-agnostic so the rules engine
   * doesn't need to know about ref objects.
   */
  runTransaction(
    auth: AuthState,
    path: string,
    updateFn: (current: JsonValue) => JsonValue | undefined,
    options?: { applyLocally?: boolean },
  ): { committed: boolean; val: JsonValue; key: string | null } {
    const applyLocally = options?.applyLocally !== false;
    const segs = pathSegments(path);
    const key = segs.length === 0 ? null : segs[segs.length - 1]!;
    let current: JsonValue = null;
    let proposed: JsonValue | undefined;
    let attempts = 0;
    let settled = false;
    do {
      attempts += 1;
      const versionBeforeCallback = this.mutationVersion;
      current = this.tree.read(path);
      // Hand the user-fn a deep clone so mutation of the arg doesn't
      // corrupt our stored tree. A synchronous re-entrant write from
      // another client invalidates this read and retries the callback,
      // matching RTDB optimistic contention semantics.
      const currentForFn = current === null ? null : coerceArrays(cloneJson(current)) as JsonValue;
      this.activeTransactionVersions.push(versionBeforeCallback);
      let conflicted = false;
      try {
        proposed = updateFn(currentForFn);
        conflicted = this.hasConflictingMutationSince(versionBeforeCallback, path);
      } finally {
        this.releaseTransactionVersion(versionBeforeCallback);
      }
      if (!conflicted || proposed === undefined) {
        settled = true;
        break;
      }
    } while (attempts < 25);
    if (!settled) throw new Error('maxretry');
    const groupId = this.nextGroupId('transaction');
    if (proposed === undefined) {
      this.emitOperation(auth, 'transaction', path, 'not-applicable', undefined, {
        origin: 'transaction',
        groupId,
        groupKind: 'transaction',
        resourceBefore: { data: current, exists: current !== null },
        detail: { committed: false, aborted: true },
      });
      // Abort — no write, no rule check, no listener fire. Resolve with
      // the pre-transaction value (oracle pinned for the seeded case:
      // `afterValOnServer: 100` preserved).
      return { committed: false, val: current, key };
    }
    // Resolve sentinels + normalize first so the rule check sees the
    // stored shape (consistent with `set`): array coercion, null/empty
    // pruning, key validation.
    const now = Date.now();
    const resolved = normalizeWrite(
      resolveSentinels(proposed, now, current) as JsonValue,
      path === '/' ? '' : path,
    );
    // Apply locally if allowed — fires listeners with the optimistic
    // value BEFORE the rule check. The single-client sandbox has a
    // synchronous commit path so this is effectively a no-op in
    // practice; the flag is honored for parity with prod's contract.
    if (applyLocally) {
      // Stash the prior value so a denial below can roll back. The
      // tree's write replaces; we hold the snapshot of the pre-write
      // root to restore on rule-deny.
      const priorRoot = this.tree.snapshot();
      const priorPriorities = new Map(this.priorities);
      const currentPriority = this.getPriority(path);
      this.tree.write(path, resolved);
      this.replacePriority(path, currentPriority);
      this.fanOut([path]);
      const at = Date.now();
      const evaluation = this.rules.evaluate('write', path === '/' ? '/' : path, {
        auth,
        mockData: priorRoot as Record<string, unknown>,
        newData: resolved,
      });
      if (evaluation.check !== 'allow') {
        this.emitOperation(auth, 'transaction', path, denyResultFor(evaluation.check), evaluation, {
          at,
          durationMs: Date.now() - at,
          origin: 'transaction',
          request: { data: proposed, resourceData: proposed },
          resourceBefore: { data: current, exists: current !== null },
          resourceAfter: { data: resolved, exists: resolved !== null },
          groupId,
          groupKind: 'transaction',
        });
        // Roll back the local apply and re-fan-out so listeners see
        // the restored value. Then throw the transaction-specific
        // denial shape.
        this.tree.restore(priorRoot);
        this.priorities.clear();
        for (const [priorityPath, priority] of priorPriorities) {
          this.priorities.set(priorityPath, priority);
        }
        this.fanOut([path]);
        throw transactionPermissionDenied();
      }
      this.emitOperation(auth, 'transaction', path, 'allow', evaluation, {
        at,
        durationMs: Date.now() - at,
        origin: 'transaction',
        request: { data: proposed, resourceData: proposed },
        resourceBefore: { data: current, exists: current !== null },
        resourceAfter: { data: resolved, exists: resolved !== null },
        groupId,
        groupKind: 'transaction',
      });
      this.emitCommit(auth, 'transaction', path, {
        data: proposed,
        priorState: current,
        nextState: resolved,
        groupId,
        groupKind: 'transaction',
        replay: { requestTime: now },
        detail: { committed: true, applyLocally: true },
      });
      this.emitRtdbEvent(auth, 'transaction', canonicalPath(path), {
        before: current,
        after: resolved,
        detail: { committed: true },
      });
      this.markMutation(path);
      this.notifyWrite();
      return { committed: true, val: resolved, key };
    }
    // applyLocally: false — rule-check FIRST, write only if allowed,
    // listeners see only the committed value.
    const at = Date.now();
    const evaluation = this.rules.evaluate('write', path === '/' ? '/' : path, {
      auth,
      mockData: this.tree.snapshot() as Record<string, unknown>,
      newData: resolved,
    });
    if (evaluation.check !== 'allow') {
      this.emitOperation(auth, 'transaction', path, denyResultFor(evaluation.check), evaluation, {
        at,
        durationMs: Date.now() - at,
        origin: 'transaction',
        request: { data: proposed, resourceData: proposed },
        resourceBefore: { data: current, exists: current !== null },
        resourceAfter: { data: resolved, exists: resolved !== null },
        groupId,
        groupKind: 'transaction',
      });
      throw transactionPermissionDenied();
    }
    this.emitOperation(auth, 'transaction', path, 'allow', evaluation, {
      at,
      durationMs: Date.now() - at,
      origin: 'transaction',
      request: { data: proposed, resourceData: proposed },
      resourceBefore: { data: current, exists: current !== null },
      resourceAfter: { data: resolved, exists: resolved !== null },
      groupId,
      groupKind: 'transaction',
    });
    const currentPriority = this.getPriority(path);
    this.tree.write(path, resolved);
    this.replacePriority(path, currentPriority);
    this.markMutation(path);
    this.fanOut([path]);
    this.emitCommit(auth, 'transaction', path, {
      data: proposed,
      priorState: current,
      nextState: resolved,
      groupId,
      groupKind: 'transaction',
      replay: { requestTime: now },
      detail: { committed: true, applyLocally: false },
    });
    this.emitRtdbEvent(auth, 'transaction', canonicalPath(path), {
      before: current,
      after: resolved,
      detail: { committed: true },
    });
    return { committed: true, val: resolved, key };
  }

  // ─── Child-event listeners (Tier 2) ────────────────────────────────
  //
  // Per-child diff fanout. Each child listener watches a parent path;
  // on write we compare the parent's prior children against its next
  // children and dispatch `child_added` / `child_changed` /
  // `child_removed` accordingly.
  //
  // `child_moved` uses the active index: an explicit query order when
  // present, otherwise Firebase's default priority/key order.

  /**
   * Subscribe to a child event at `path`.
   *
   * Semantics (locked by oracle observations under
   * `packages/conformance/observations/rtdb-modular/rtdb-modular-onchild*.json`):
   *
   *   - `child_added`: replays every existing direct child of `path` on
   *     subscribe (one fire per existing key, in default priority/key
   *     order — matches the upstream default index captured in
   *     `rtdb-modular-onchildadded-initial-replay`). Subsequent
   *     additions fire once each.
   *   - `child_changed`: no initial replay. Fires when an existing
   *     child's value transitions to a NEW non-null value. Snapshot
   *     carries the NEW value.
   *   - `child_removed`: no initial replay. Fires when a child is
   *     deleted (its value transitions to absent). Snapshot carries
   *     the PRIOR (now-removed) value.
   *   - `child_moved`: fires for the reprioritized direct child even when
   *     its predecessor is unchanged, matching Firebase's priority index.
   *
   * Rules check happens at subscribe time, identical to `onValue`. A
   * denied subscribe throws the plain-`Error` `PERMISSION_DENIED`
   * shape and the listener is never registered.
   *
   * Returns an idempotent unsubscribe.
   */
  onChild(
    auth: AuthState,
    event: ChildListener['event'],
    path: string,
    cb: (snap: { key: string; val: JsonValue; previousChildName: string | null }) => void,
    spec?: QuerySpec,
    cancelCallback?: (error: Error) => void,
    onCanceled?: () => void,
  ): () => void {
    const listenerId = this.nextListenerId();
    const at = Date.now();
    const evaluation = this.rules.evaluate('read', path === '/' ? '/' : path, {
      auth,
      mockData: this.tree.snapshot() as Record<string, unknown>,
    });
    if (evaluation.check !== 'allow') {
      this.emitOperation(auth, 'listen', path, denyResultFor(evaluation.check), evaluation, {
        at,
        durationMs: Date.now() - at,
        origin: 'listener',
        detail: { event },
      });
      this.emitListener('errored', { id: listenerId, path }, auth, {
        event,
        result: 'deny',
        error: {
          code: 'PERMISSION_DENIED',
          message: 'PERMISSION_DENIED: Permission denied',
          reasons: evaluation.reasons,
        },
      });
      if (cancelCallback) {
        queueMicrotask(() => {
          onCanceled?.();
          cancelCallback(listenerPermissionDenied(path));
        });
        return () => {};
      }
      throw permissionDenied();
    }
    this.emitOperation(auth, 'listen', path, 'allow', evaluation, {
      at,
      durationMs: Date.now() - at,
      origin: 'listener',
      detail: { event },
    });
    const listener: ChildListener = {
      id: listenerId,
      auth,
      event,
      path,
      cb,
      spec,
      cancelCallback,
      onCanceled,
    };
    this.childListeners.add(listener);
    this.emitListener('attach', listener, auth, {
      event,
      result: 'allow',
      detail: spec ? { query: spec } : undefined,
    });
    // Initial state. A query child listener records its ordered window so
    // the next write's diff knows what "the previous result" was; a
    // `child_added` query listener also replays the window (in window
    // order). A plain-ref listener replays raw direct children.
    if (spec) {
      const initialWindow = executeQuery(this.tree.read(path), spec, this.priorityForChild(path));
      listener.lastWindow = initialWindow;
      if (event === 'child_added') {
        for (const { key, value } of initialWindow) {
          this.emitListener('delivery', listener, auth, {
            event,
            size: 1,
            sample: { key, val: value },
            detail: { initial: true, query: true },
          });
          try {
            cb({
              key,
              val: value,
              previousChildName: previousName(initialWindow, key),
            });
          } catch (e) {
            this.emitListener('errored', listener, auth, {
              event,
              result: 'error',
              error: { message: e instanceof Error ? e.message : String(e) },
              detail: { initial: true, query: true },
            });
            // Swallow — see fanOut.
          }
        }
      }
    } else if (event === 'child_added') {
      // Initial replay — only `child_added` replays existing children.
      for (const { key, val } of this.directChildren(path)) {
        this.emitListener('delivery', listener, auth, {
          event,
          size: 1,
          sample: { key, val },
          detail: { initial: true },
        });
        try {
          const children = this.directChildren(path);
          cb({ key, val, previousChildName: previousNameFromValues(children, key) });
        } catch (e) {
          this.emitListener('errored', listener, auth, {
            event,
            result: 'error',
            error: { message: e instanceof Error ? e.message : String(e) },
            detail: { initial: true },
          });
          // Swallow — see fanOut.
        }
      }
    }
    return () => {
      this.childListeners.delete(listener);
      this.emitListener('detach', listener, auth, { event });
    };
  }

  /**
   * `off(refPath, eventType?, callback?)` — unsubscribe variant. Matches
   * the upstream contract (oracle: `rtdb-modular-off-stops-child-fires`):
   *
   *   - `off(refPath)` removes ALL listeners (value + child) at the path.
   *   - `off(refPath, 'value')` removes only `value` listeners at the path.
   *   - `off(refPath, 'child_added')` (or any child event type) removes
   *     only that child-event variety at the path.
   *   - `off(refPath, eventType, cb)` removes only the matching callback.
   *
   * No-throw on absent listeners — matches the upstream behavior.
   */
  off(
    path: string,
    eventType?: 'value' | ChildListener['event'],
    callback?: ((snap: unknown) => void) | unknown,
  ): void {
    const canonical = joinPath(pathSegments(path));
    // Value listeners.
    if (eventType === undefined || eventType === 'value') {
      for (const l of [...this.valueListeners]) {
        if (joinPath(pathSegments(l.path)) !== canonical) continue;
        if (callback !== undefined && l.cb !== callback) continue;
        this.valueListeners.delete(l);
        this.emitListener('detach', l, l.auth, { event: 'value' });
      }
    }
    // Child listeners.
    const childEvents: ChildListener['event'][] = [
      'child_added',
      'child_changed',
      'child_removed',
      'child_moved',
    ];
    const targetEvents = eventType === undefined
      ? childEvents
      : eventType === 'value'
        ? []
        : [eventType as ChildListener['event']];
    if (targetEvents.length > 0) {
      for (const l of [...this.childListeners]) {
        if (!targetEvents.includes(l.event)) continue;
        if (joinPath(pathSegments(l.path)) !== canonical) continue;
        if (callback !== undefined && l.cb !== callback) continue;
        this.childListeners.delete(l);
        this.emitListener('detach', l, l.auth, { event: l.event });
      }
    }
  }

  /** Direct children of `path` in Firebase's default priority/key order. */
  private directChildren(path: string): Array<{ key: string; val: JsonValue }> {
    const v = this.tree.read(path);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return [];
    return executeQuery(
      v,
      { orderBy: { kind: 'priority' }, bounds: [], limit: null },
      this.priorityForChild(path),
    ).map(({ key, value }) => ({ key, val: value }));
  }

  /** Snapshot the current direct children of every registered child
   *  listener's parent path. Used to capture the "prior" half of the
   *  diff before a write applies. */
  private snapshotChildListenerParents(): Map<string, Map<string, JsonValue>> {
    const out = new Map<string, Map<string, JsonValue>>();
    if (this.childListeners.size === 0) return out;
    for (const listener of this.childListeners) {
      const canonical = joinPath(pathSegments(listener.path));
      if (out.has(canonical)) continue;
      const map = new Map<string, JsonValue>();
      for (const { key, val } of this.directChildren(canonical)) {
        map.set(key, val);
      }
      out.set(canonical, map);
    }
    return out;
  }

  /**
   * Fan out child events after a write. `priorByParent` is the snapshot
   * captured by `snapshotChildListenerParents` before the write applied.
   *
   * For each listener, compute the diff between prior and current
   * children, then dispatch:
   *   - `child_added` when a key appears that wasn't in prior.
   *   - `child_changed` when a key's value transitions.
   *   - `child_removed` when a prior key is gone.
   */
  private fanOutChildren(
    priorByParent: Map<string, Map<string, JsonValue>>,
    priorityChangedPath?: string,
  ): void {
    if (this.childListeners.size === 0) return;
    // Group PLAIN-ref listeners by their canonical parent path so we only
    // do one diff per parent regardless of how many listeners are attached.
    // Query listeners diff their ordered window per-listener (below) — the
    // raw key-set diff would ignore the window/ordering.
    const byParent = new Map<string, ChildListener[]>();
    for (const listener of this.childListeners) {
      if (listener.spec) {
        this.fanOutQueryChild(listener, priorityChangedPath);
        continue;
      }
      const canonical = joinPath(pathSegments(listener.path));
      const arr = byParent.get(canonical) ?? [];
      arr.push(listener);
      byParent.set(canonical, arr);
    }
    for (const [parentPath, listeners] of byParent) {
      const prior = priorByParent.get(parentPath) ?? new Map<string, JsonValue>();
      const next = new Map<string, JsonValue>();
      for (const { key, val } of this.directChildren(parentPath)) {
        next.set(key, val);
      }
      // Build event lists.
      const added: Array<{ key: string; val: JsonValue; previousChildName: string | null }> = [];
      const changed: Array<{ key: string; val: JsonValue; previousChildName: string | null }> = [];
      const removed: Array<{ key: string; val: JsonValue; previousChildName: string | null }> = [];
      let moved: Array<{ key: string; val: JsonValue; previousChildName: string | null }> = [];
      const nextEntries = [...next].map(([key, val]) => ({ key, val }));
      const priorEntries = [...prior].map(([key, val]) => ({ key, val }));
      for (const [k, v] of next) {
        if (!prior.has(k)) {
          added.push({ key: k, val: v, previousChildName: previousNameFromValues(nextEntries, k) });
        } else if (!jsonValuesEqual(prior.get(k)!, v)) {
          changed.push({ key: k, val: v, previousChildName: previousNameFromValues(nextEntries, k) });
        }
      }
      for (const [k, v] of prior) {
        if (!next.has(k)) {
          removed.push({ key: k, val: v, previousChildName: previousNameFromValues(priorEntries, k) });
        }
      }
      const changedPriorityKey = directChildKey(parentPath, priorityChangedPath);
      if (changedPriorityKey !== null) {
        const priorIndex = priorEntries.findIndex((row) => row.key === changedPriorityKey);
        const nextIndex = nextEntries.findIndex((row) => row.key === changedPriorityKey);
        if (priorIndex >= 0 && nextIndex >= 0) {
          const reprioritized = nextEntries[nextIndex]!;
          moved = [{
            key: reprioritized.key,
            val: reprioritized.val,
            previousChildName: previousNameFromValues(nextEntries, reprioritized.key),
          }];
        }
      }
      for (const listener of listeners) {
        let events: Array<{ key: string; val: JsonValue; previousChildName: string | null }>;
        switch (listener.event) {
          case 'child_added': events = added; break;
          case 'child_changed': events = changed; break;
          case 'child_removed': events = removed; break;
          case 'child_moved': events = moved; break;
        }
        for (const ev of events) {
          this.emitListener('delivery', listener, listener.auth, {
            event: listener.event,
            size: 1,
            sample: ev,
          });
          try {
            listener.cb(ev);
          } catch (e) {
            this.emitListener('errored', listener, listener.auth, {
              event: listener.event,
              result: 'error',
              error: { message: e instanceof Error ? e.message : String(e) },
            });
            // Swallow — see fanOut.
          }
        }
      }
    }
  }

  /**
   * Fan out a single QUERY child listener after a write, diffing the
   * ordered window against the listener's last-fired window:
   *
   *   - a key that ENTERED the window emits `child_added` (window order);
   *   - a key that LEFT the window emits `child_removed` (carrying its
   *     prior value);
   *   - a key that stayed in-window but changed value emits `child_changed`.
   *
   * `child_moved` emits when the active ordered value changes. The window is
   * always advanced so later add/change/remove/move diffs remain coherent.
   */
  private fanOutQueryChild(listener: ChildListener, priorityChangedPath?: string): void {
    const prior = listener.lastWindow ?? [];
    const next = executeQuery(
      this.tree.read(listener.path),
      listener.spec!,
      this.priorityForChild(listener.path),
    );
    listener.lastWindow = next;
    const priorByKey = new Map<string, JsonValue>(prior.map((r) => [r.key, r.value]));
    const nextByKey = new Map<string, JsonValue>(next.map((r) => [r.key, r.value]));
    let events: Array<{ key: string; val: JsonValue; previousChildName: string | null }> = [];
    switch (listener.event) {
      case 'child_added':
        for (const { key, value } of next) {
          if (!priorByKey.has(key)) {
            events.push({ key, val: value, previousChildName: previousName(next, key) });
          }
        }
        break;
      case 'child_changed':
        for (const { key, value } of next) {
          if (priorByKey.has(key) && !jsonValuesEqual(priorByKey.get(key)!, value)) {
            events.push({ key, val: value, previousChildName: previousName(next, key) });
          }
        }
        break;
      case 'child_removed':
        for (const { key, value } of prior) {
          if (!nextByKey.has(key)) {
            events.push({ key, val: value, previousChildName: previousName(prior, key) });
          }
        }
        break;
      case 'child_moved':
        if (listener.spec?.orderBy && listener.spec.orderBy.kind !== 'key') {
          const changedPriorityKey = listener.spec.orderBy.kind === 'priority'
            ? directChildKey(listener.path, priorityChangedPath)
            : null;
          if (changedPriorityKey !== null) {
            const priorIndex = prior.findIndex((row) => row.key === changedPriorityKey);
            const nextIndex = next.findIndex((row) => row.key === changedPriorityKey);
            if (priorIndex >= 0 && nextIndex >= 0) {
              const changed = next[nextIndex]!;
              events = [{
                key: changed.key,
                val: changed.value,
                previousChildName: previousName(next, changed.key),
              }];
              break;
            }
          }
          const priorRows = new Map(prior.map((row) => [row.key, row]));
          for (const row of next) {
            const priorRow = priorRows.get(row.key);
            if (!priorRow) continue;
            const before = extractOrderValue(
              listener.spec.orderBy,
              priorRow.key,
              priorRow.value,
              priorRow.priority,
            );
            const after = extractOrderValue(
              listener.spec.orderBy,
              row.key,
              row.value,
              row.priority,
            );
            if (compareValues(before, after) !== 0) {
              events.push({
                key: row.key,
                val: row.value,
                previousChildName: previousName(next, row.key),
              });
            }
          }
        }
        break;
    }
    for (const ev of events) {
      this.emitListener('delivery', listener, listener.auth, {
        event: listener.event,
        size: 1,
        sample: ev,
        detail: { query: true },
      });
      try {
        listener.cb(ev);
      } catch (e) {
        this.emitListener('errored', listener, listener.auth, {
          event: listener.event,
          result: 'error',
          error: { message: e instanceof Error ? e.message : String(e) },
          detail: { query: true },
        });
        // Swallow — see fanOut.
      }
    }
  }

  // ─── Persistence (PersistableService) ──────────────────────────────
  //
  // The RTDB value tree and priority metadata ride the sandbox persistence
  // controller's `services` blob. `getDatabase(sandbox)` registers
  // these hooks once per sandbox (see modular.ts). Together they give RTDB
  // the same durability contract as Firestore/auth: worker death / browser
  // restart restores the whole tree instead of losing it.

  /** Serialize the whole tree as a plain JSON value for the persistence
   *  snapshot. Defensive deep-copy (via `DataTree.snapshot`). */
  exportTree(): JsonValue {
    return this.tree.snapshot();
  }

  /** Persistence-only envelope. `exportTree()` intentionally remains the
   * public raw-data snapshot used by owner controls and Studio. */
  exportPersistenceState(): JsonValue {
    return {
      '.pyricRtdbPersistence': 1,
      data: this.tree.snapshot(),
      priorities: Object.fromEntries(this.priorities),
    } as JsonValue;
  }

  /**
   * Replace the whole tree with a persisted snapshot, then fire listeners
   * so any live UI (Studio's RTDB tab) converges on the restored data
   * rather than showing a stale/empty view.
   *
   * REPLACE, not merge — the tree becomes EXACTLY the snapshot. On boot /
   * late-registration the tree is empty so this is a pure load; for a
   * runtime `loadSnapshot()` it clobbers divergent state, matching auth's
   * restore policy.
   *
   * Notification: we capture each child-listener parent's prior children
   * BEFORE the swap, then fan out value listeners from the root (every
   * listener re-reads its path) and child listeners against the diff. The
   * value-listener no-op suppression (DB-B8) means a listener whose subtree
   * is byte-identical to the snapshot won't spuriously re-fire.
   */
  restoreTree(root: JsonValue): void {
    const priors = this.snapshotChildListenerParents();
    const persisted = decodePersistenceState(root);
    this.tree.restore(persisted.data ?? {});
    this.priorities.clear();
    for (const [path, priority] of Object.entries(persisted.priorities)) {
      this.priorities.set(joinPath(pathSegments(path)), priority);
    }
    this.markMutation('/');
    this.fanOut(['/']);
    this.fanOutChildren(priors);
  }

  /** Reset sandbox data and invalidate every ephemeral client connection queue. */
  resetTree(): void {
    this.invalidateConnectionQueues();
    this.restoreTree(null);
  }

  /**
   * Register a persistence change-subscriber. Returns an unsubscribe.
   * Fired (best-effort, isolated) after every committed tree mutation so
   * the controller schedules a debounced flush.
   */
  subscribeWrites(onChange: () => void): () => void {
    this.writeSubscribers.add(onChange);
    return () => {
      this.writeSubscribers.delete(onChange);
    };
  }

  /** Notify persistence subscribers that the tree changed. Best-effort +
   *  isolated — a subscriber throw must never break the write. */
  private notifyWrite(): void {
    if (this.writeSubscribers.size === 0) return;
    for (const sub of this.writeSubscribers) {
      try {
        sub();
      } catch {
        // Observational — never let a flush-scheduler throw break a write.
      }
    }
  }

  /** Generate a key without writing (advisory — same key the next
   *  `push(path)` would produce). Used by the `ref.push().key`
   *  pattern. Each call returns a fresh key. */
  mintKey(): string {
    return generatePushId();
  }

  /** Test helper — count value listeners. */
  listenerCount(): number {
    return this.valueListeners.size;
  }

  /** Test helper — count child listeners. */
  childListenerCount(): number {
    return this.childListeners.size;
  }
}

/** Normalize a path to its canonical `/`-joined form for event paths. */
function canonicalPath(path: string): string {
  return joinPath(pathSegments(path));
}

/**
 * Transaction-specific denial constructor. Pinned by oracle observation
 * `rtdb-modular-runtransaction-on-rules-denied-path.json`:
 *
 *   - plain `Error` (NOT `FirebaseError`).
 *   - `.message === 'permission_denied'` (LOWERCASE — distinct from
 *     `set`/`get`'s `'PERMISSION_DENIED: Permission denied'` shape).
 *   - **No** `.code` field on the error (prod observation shows
 *     `code: null` — the FirebaseError code shape isn't applied to
 *     transaction rejections).
 *   - `.constructor.name === 'Error'`.
 *
 * This is a deliberately distinct shape from the regular
 * `permissionDenied()` used by `set`/`get`/`update` — prod really does
 * emit a different surface for `runTransaction` rejections. The test
 * suite asserts both shapes so a future "unify the error shape"
 * refactor would catch the divergence at unit time.
 */
function transactionPermissionDenied(): Error {
  return new Error('permission_denied');
}

/**
 * Pack an ordered list of `QueryRow`s into a JSON object — the shape
 * the `DataSnapshot.val()` contract returns from a query.
 *
 * RTDB query snapshots present the windowed rows as a key→value object;
 * ordering is observable via `snap.forEach` (NOT through `val()`'s
 * iteration order, which is unspecified for plain objects but happens
 * to be insertion order in modern V8). The sandbox snap-wrapper
 * preserves the row order so `snap.forEach` yields children in the
 * computed query order.
 */
function rowsToVal(rows: QueryRow[]): JsonValue {
  if (rows.length === 0) return null;
  const out: Record<string, JsonValue> = {};
  for (const { key, value } of rows) {
    out[key] = value;
  }
  return out;
}

function validatePriority(priority: Priority): void {
  if (
    priority !== null
    && typeof priority !== 'string'
    && (typeof priority !== 'number' || !Number.isFinite(priority))
  ) {
    throw new Error('priority must be a valid Firebase priority (string, finite number, or null)');
  }
}

function listenerPermissionDenied(path: string): Error {
  const error = new Error(
    `permission_denied at ${joinPath(pathSegments(path))}: Client doesn't have permission to access the desired data.`,
  ) as Error & { code: string };
  error.code = 'PERMISSION_DENIED';
  return error;
}

function previousName(rows: QueryRow[], key: string): string | null {
  const index = rows.findIndex((row) => row.key === key);
  return index > 0 ? rows[index - 1]!.key : null;
}

function previousNameFromValues(
  rows: Array<{ key: string; val: JsonValue }>,
  key: string,
): string | null {
  const index = rows.findIndex((row) => row.key === key);
  return index > 0 ? rows[index - 1]!.key : null;
}

function directChildKey(parentPath: string, changedPath?: string): string | null {
  if (changedPath === undefined) return null;
  const parent = pathSegments(parentPath);
  const changed = pathSegments(changedPath);
  if (changed.length !== parent.length + 1) return null;
  if (!parent.every((segment, index) => changed[index] === segment)) return null;
  return changed[changed.length - 1] ?? null;
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === '/' || right === '/') return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function decodePersistenceState(root: JsonValue): {
  data: JsonValue;
  priorities: Record<string, Exclude<Priority, null>>;
} {
  if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
    const candidate = root as Record<string, JsonValue>;
    const encodedPriorities = candidate.priorities;
    if (
      candidate['.pyricRtdbPersistence'] === 1
      && 'data' in candidate
      && encodedPriorities !== null
      && typeof encodedPriorities === 'object'
      && !Array.isArray(encodedPriorities)
    ) {
      const priorities: Record<string, Exclude<Priority, null>> = {};
      for (const [path, priority] of Object.entries(encodedPriorities)) {
        if (typeof priority === 'string' || (typeof priority === 'number' && Number.isFinite(priority))) {
          priorities[path] = priority;
        }
      }
      return { data: candidate.data ?? null, priorities };
    }
  }
  return { data: root, priorities: {} };
}

/** Compare two windowed result lists. Used to decide whether a query
 *  listener should re-fire. Uses RTDB JSON value equality rather than
 *  `JSON.stringify` so a re-write that only reorders object keys is
 *  correctly treated as "no change" (DB-B11: RTDB treats objects as
 *  order-equal). */
function windowsEqual(a: QueryRow[], b: QueryRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai.key !== bi.key) return false;
    if (ai.priority !== bi.priority) return false;
    if (!jsonValuesEqual(ai.value, bi.value)) return false;
  }
  return true;
}

// Re-exports the modular SDK uses internally.
export { cloneJson, pathSegments, joinPath } from './data-tree.js';
export type { JsonValue } from './data-tree.js';
export type { QuerySpec, QueryRow } from './query.js';
