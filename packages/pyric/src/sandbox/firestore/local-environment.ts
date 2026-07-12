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
import { lintFirestoreRules, parseToAST, type LintResult } from 'pyric/rules/internal';
import type {
  TestCase,
  FirestoreRules,
  ListQuery,
  TestResult,
  TestFirestoreRulesResult,
} from 'pyric/rules/internal';
// RULES-B11 — query-proof gate for list reads ("rules are not filters").
import { proveListQuery, type QueryConstraints } from './list-query-proof.js';
import {
  resolveValueTree,
  partitionDeletes,
  registerDefaultConverters,
  type ResolveMethod,
} from './value-resolver.js';
import { assertNoNestedDeleteField } from './field-merge.js';
import { Timestamp } from 'pyric/rules/internal';
import { makeError, type FirestoreSimError } from './errors.js';
import { generateAutoId } from './auto-id.js';
import { walkForSentinels, type SentinelHit } from './sentinel-capture.js';
import { TransactionContext, type TransactionReader } from './transaction.js';
import { mergeQueuedWrites } from './transaction-merge.js';
import type {
  Transaction,
  TransactionOptions,
  TransactionResult,
} from './transaction-types.js';
import type {
  DocumentSnapshot,
  ListenerAuth,
  ListenerRecord,
  QueryConstraintApplier,
  QuerySnapshot,
  SnapshotCallback,
  SnapshotErrorCallback,
  SnapshotListenerOptions,
  SnapshotTarget,
} from './snapshot-listeners.js';
import {
  buildDocumentSnapshot,
  buildQuerySnapshot,
  SANDBOX_METADATA,
  SANDBOX_METADATA_PENDING,
} from './snapshot-listeners.js';

// Register every shipped converter exactly once on module load. Idempotent
// per-converter, so re-imports are safe. Item 0 ships an empty registry;
// Items 1+ add converters here.
registerDefaultConverters();

/**
 * Wallclock-aligned ISO string for `tc.requestTime`. Both `request.time`
 * and any `serverTimestamp()` sentinel in this write must resolve to a
 * field-equal Timestamp; we accomplish that by computing a single
 * Timestamp here and forwarding the millisecond-precise ISO to handler.ts
 * (which parses it back into a Timestamp via `Timestamp.fromIsoString`,
 * lossless on the millisecond grid).
 */
function isoFromTimestamp(ts: Timestamp): string {
  return new Date(ts.toMillis()).toISOString();
}

/**
 * Thrown by `LocalEnvironment.execute` / `.batch` when the simulator
 * abstained on a rule (state: UNSUPPORTED). The agent's rule may be
 * correct — the simulator just doesn't implement the feature it uses.
 *
 * Returning `allowed: false` here would silently re-create the
 * misleading-DENY pattern that Item 0.A is designed to prevent (the
 * agent can't tell sim-gap apart from real rule bug). Throwing forces
 * the test to fail loudly with an actionable message pointing at the
 * production Test API as the workaround.
 */
export class SimulatorUnsupportedError extends Error {
  constructor(
    message: string,
    public readonly method: string,
    public readonly path: string,
    public readonly debugMessages: string[],
  ) {
    super(message);
    this.name = 'SimulatorUnsupportedError';
  }
}

function unsupportedMessage(method: string, path: string, debugMessages: string[]): string {
  const reasons = debugMessages
    .filter(m => m.includes('unsupported:'))
    .map(m => m.replace(/^.*unsupported:\s*/, ''))
    .join('; ');
  const reasonClause = reasons ? ` Reason(s): ${reasons}.` : '';
  return (
    `Simulator cannot decide ${method} on ${path} — the rule uses a feature ` +
    `the local simulator does not yet implement.${reasonClause} ` +
    `Verify this rule against production using TestFirestoreRulesHandler, ` +
    `or file a sim-gap entry in REBUILD_PLAN.md.`
  );
}

/**
 * Compare two doc payloads for snapshot-suppression purposes. `null`
 * means the doc is absent. Equality test uses `JSON.stringify` to
 * mirror `computeChanges` in `snapshot-listeners.ts` — keeps the two
 * change-detection paths consistent and good enough for sandbox data
 * (all `DocumentData` is JSON-serialisable post-sentinel-resolution).
 */
function docDataEqual(a: DocumentData | null, b: DocumentData | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True if any path in `paths` is a direct child document of
 * `collection`. Used as a cheap pre-filter for query-listener
 * notifications: we only re-read the collection when something it
 * could plausibly contain was just touched. Slice 6 may revisit when
 * subcollection-aware queries land — current shape keeps the filter
 * conservative (no false negatives) at the cost of an occasional
 * false positive that the change-set diff then suppresses.
 */
function anyPathInCollection(paths: ReadonlySet<string>, collection: string): boolean {
  const prefix = `${collection}/`;
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const remaining = p.slice(prefix.length);
    if (remaining.length > 0 && !remaining.includes('/')) return true;
  }
  return false;
}

export interface Operation {
  /**
   * `'set'` is the replace-semantics single-write counterpart of the
   * batch `'set'` op: storage replaces, rule eval translates to
   * `'create'` (doc absent) or `'update'` (doc exists). Use it for
   * `DocumentReference.set(data)` without merge options.
   */
  method: 'get' | 'list' | 'create' | 'update' | 'set' | 'delete';
  path: string;
  auth: { uid: string; token?: Record<string, unknown> } | null;
  data?: DocumentData;
  /** Signals that this `create`'s path-last-segment was minted by
   *  `LocalEnvironment.createWithAutoId` (not user-supplied). The
   *  replay engine reads `WriteSandboxEvent.autoId` and mints a fresh
   *  ID on replay rather than preserving the original. Only meaningful
   *  on `method: 'create'`; ignored otherwise. */
  autoId?: boolean;
  /** Pin the server-time the rule engine sees for this op (replaces
   *  `Timestamp.fromMillis(Date.now())`). Used by the replay engine
   *  with `pinRequestTime: true` so `serverTimestamp()` sentinels
   *  resolve to the captured value and rules that branch on
   *  `request.time` evaluate identically on replay. */
  requestTime?: Timestamp;
  /** FS-B6 — `setDoc(data, {merge})` storage semantics. When set, an
   *  `update`/`create` op DEEP-merges (`merge: true`) or projects to the
   *  listed field paths (`{ mergeFields }`) instead of the shallow
   *  field-path update. Rule evaluation is unaffected (merge still
   *  evaluates as create-when-absent / update-when-present). Only
   *  meaningful when `doc-ref.set` routes a merge write through here. */
  merge?: boolean | { mergeFields: readonly string[] };
  /**
   * Studio admin lens (Pyric Studio Gap #2). When `true`, rule
   * evaluation is SKIPPED for this op — `simulate()` is never called and
   * the op is treated as ALLOW. The write still goes through `applyWrite`
   * (so structural preconditions like create-already-exists / update-
   * missing STILL apply, matching real Firestore admin) and still emits
   * the same `request`/`write` events + wakes listeners. This is the
   * modular-shaped sibling of the path-string `adminSetDocument` /
   * `adminDeleteDocument` bypass — same effect (rules off, store + events
   * on), reachable through the chainable/modular op surface. Default
   * (absent/false) is the unchanged rules-enforced path. */
  bypassRules?: boolean;
}

// ─── RequestEvent emission (issue #307) ───────────────────────────────

/**
 * Input to {@link LocalEnvironment.emitRequest}. The internal shape the
 * env's emit sites assemble; `buildRequestEvent` converts to the public
 * `RequestEvent` shape consumers see.
 */
interface EmitRequestInput {
  at: number;
  evalMs: number;
  method: Operation['method'];
  path: string;
  auth: Operation['auth'];
  result: 'allow' | 'deny' | 'unsupported';
  debugMessages: string[];
  /** The deciding rule's verdict + line + sub-expression trace (from
   *  `projectEvaluatedRule`). Surfaced on allow AND deny events (see
   *  `buildRequestEvent`); never on unsupported. */
  evaluatedRule?: EvaluatedRuleInfo;
  resourceData?: DocumentData;
  resourceBefore?: { data: DocumentData | null; exists: boolean };
  resourceAfter?: { data: DocumentData | null; exists: boolean };
  origin: 'user' | 'listener' | 'transaction' | 'batch' | 'admin';
  groupId?: string;
  triggeredBy?: { method: string; path: string };
  detail?: { admin?: boolean } & Record<string, unknown>;
}

let _requestEventSeq = 0;

function nextRequestEventId(): string {
  // Monotonic + random tail. Stable for the lifetime of the JS process;
  // doesn't try to be cryptographically unique because consumers use it
  // as a React list key, not a security token.
  _requestEventSeq = (_requestEventSeq + 1) >>> 0;
  return `req-${_requestEventSeq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Parse `Rule #N (ops...) → ALLOW/deny` lines out of the simulator's
 * debug messages. The simulator emits one such line per evaluated rule
 * in the matched match block (see `evaluateRules` in
 * `pyric/rules/handler.ts`). For allowed outcomes
 * the last `→ ALLOW` rule wins; for denials we surface the first rule
 * that even tried to match this op-set.
 */
function parseMatchedRule(
  debugMessages: string[],
  result: 'allow' | 'deny' | 'unsupported',
): { ruleIndex: number; operations: string[] } | undefined {
  const wantAllow = result === 'allow';
  let last: { ruleIndex: number; operations: string[] } | undefined;
  for (const msg of debugMessages) {
    const m = /^Rule #(\d+) \(([^)]+)\) → (ALLOW|deny|unsupported)/.exec(msg);
    if (!m) continue;
    const candidate = {
      ruleIndex: Number(m[1]),
      operations: m[2].split(',').map((s) => s.trim()),
    };
    if (wantAllow && m[3] === 'ALLOW') return candidate;
    last = candidate;
  }
  return last;
}

function buildRequestEvent(input: EmitRequestInput): import('../types/events.js').RequestEvent {
  const out: import('../types/events.js').RequestEvent = {
    kind: 'request',
    id: nextRequestEventId(),
    at: input.at,
    evalMs: input.evalMs,
    method: input.method,
    path: input.path,
    auth: input.auth ? { uid: input.auth.uid, ...(input.auth.token ? { token: input.auth.token } : {}) } : null,
    result: input.result,
    reasons: input.debugMessages,
    origin: input.origin,
  };
  if (input.resourceData !== undefined) {
    out.request = { resourceData: input.resourceData };
  }
  if (input.resourceBefore !== undefined) {
    out.resourceBefore = input.resourceBefore;
  }
  if (input.resourceAfter !== undefined) {
    out.resourceAfter = input.resourceAfter;
  }
  const matched = parseMatchedRule(input.debugMessages, input.result);
  if (matched) out.matchedRule = matched;
  // The structured deciding-rule projection (verdict + line + expression
  // trace) rides alongside the flat `reasons` on rules-evaluated results —
  // the allowing rule on an allow, the denying rule on a deny. Unsupported
  // results have no deciding rule (the simulator abstained).
  if (input.result !== 'unsupported' && input.evaluatedRule) {
    out.evaluatedRule = input.evaluatedRule;
  }
  if (input.groupId !== undefined) {
    out.groupId = input.groupId;
    // Disambiguates 'origin' for consumers that want the group kind
    // without re-parsing the prefix.
    if (input.origin === 'batch') out.groupKind = 'batch';
    else if (input.origin === 'transaction') out.groupKind = 'transaction';
  }
  if (input.triggeredBy !== undefined) out.triggeredBy = input.triggeredBy;
  if (input.detail !== undefined) out.detail = input.detail;
  return out;
}

function listQueryFromStructured(structured: QueryConstraints): ListQuery | undefined {
  if (structured.limit == null && structured.offset == null && structured.orderBy == null) {
    return undefined;
  }
  return {
    ...(structured.limit != null ? { limit: structured.limit } : {}),
    ...(structured.offset != null ? { offset: structured.offset } : {}),
    ...(structured.orderBy != null ? { orderBy: structured.orderBy } : {}),
  };
}

export interface OperationResult {
  allowed: boolean;
  data?: DocumentData | null;
  debugMessages: string[];
  event: AgentEvent;
  /**
   * Item 6 — typed error code present on every denial / structural
   * failure. Absent when `allowed: true`. See {@link FirestoreSimError}
   * for the canonical code set and {@link makeError} for construction.
   */
  error?: FirestoreSimError;
}

export interface BatchOperationInput {
  method: 'create' | 'update' | 'delete';
  path: string;
  data?: DocumentData;
}

/**
 * A synthetic all-ALLOW {@link TestResult} for the admin-bypass path
 * (Pyric Studio Gap #2). Returned by {@link LocalEnvironment.runSimulate}
 * instead of calling the rules engine when an op carries `bypassRules`.
 * `state: 'PASSED'` + `decision: 'ALLOW'` is exactly the shape every
 * write/read site downstream of a `simulate()` call already branches on,
 * so the bypass reuses the entire existing execute/batch/transaction
 * apply + emit machinery unchanged — only the rule decision is forced.
 * The `notes` line makes the bypass legible in the `debugMessages` trail
 * that surfaces on the traffic log.
 */
function adminBypassResult(description = ''): TestResult {
  return {
    description,
    expectation: 'ALLOW',
    state: 'PASSED',
    decision: 'ALLOW',
    trace: [],
    notes: ['admin lens — rules bypassed (Studio Gap #2)'],
  };
}

export interface BatchResult {
  allowed: boolean;
  results: {
    path: string;
    allowed: boolean;
    debugMessages: string[];
    /** Item 6 — populated for any per-op denial inside the batch. */
    error?: FirestoreSimError;
  }[];
  event: AgentEvent;
  /**
   * Item 6 — top-level batch error. Set when the batch as a whole was
   * rejected (atomic rollback) — typically the first per-op error, or
   * a sentinel-resolution error that aborted before per-op evaluation.
   */
  error?: FirestoreSimError;
}

/**
 * Default ruleset for a freshly-constructed sandbox. Open read+write
 * on every path — the right behavior for the quickstart / local dev
 * loop where rules haven't been considered yet. Callers tighten this
 * via `setRules(...)`; production code never relies on the default.
 */
const DEFAULT_OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
`;

export class LocalEnvironment {
  private state: DocStore;
  private eventLog: EventLog;
  private simulator: SimulateFirestoreRulesHandler;
  private rulesSource: string;
  private seedSnapshot: Record<string, DocumentData>;
  /**
   * Subscribers notified after every `permission-denied` is constructed,
   * regardless of whether downstream user code catches the resulting
   * throw. Lets host environments (the playground runner, tests) surface
   * denials with full eval context even when test code wraps the call
   * in try/catch — the catch otherwise hides everything past `e.code`.
   */
  private denialListeners: Set<(err: FirestoreSimError) => void> = new Set();

  /**
   * Subscribers notified for every evaluated op (issue #307). Each
   * receives a public-shape `RequestEvent`. Re-shape from the internal
   * eval payload happens in {@link emitRequest} so the env's hot path
   * doesn't allocate the event object until we know someone's listening.
   *
   * Listener throws are swallowed (same rationale as `denialListeners`).
   */
  private requestListeners: Set<(event: import('../types/events.js').RequestEvent) => void> = new Set();

  /**
   * Subscribers notified for every COMMITTED write (issue #307). Fires
   * after the keyspace successfully applied the write — denied or
   * rolled-back writes don't emit here (they surface as a request-deny
   * RequestEvent instead). Bridged to `Sandbox.onEvent` consumers via
   * SandboxImpl's attachToEnv.
   */
  private writeListeners: Set<(event: import('../types/events.js').WriteSandboxEvent) => void> = new Set();

  /**
   * Subscribers notified for every snapshot DELIVERED to a user
   * `onSnapshot` callback. Fires after the suppress-check in
   * notify*Listener, so this count tracks real callback invocations
   * (in contrast to `requestListeners[origin='listener']`, which used
   * to over-count before the step-5 refactor).
   */
  private deliveryListeners: Set<(event: import('../types/events.js').SnapshotDeliveryEvent) => void> = new Set();

  /**
   * Subscribers notified for every listener re-eval that was suppressed
   * before reaching the user callback — Slice 3's no-op suppression
   * surfaces here. Useful for "why didn't my listener fire" debugging.
   */
  private suppressedListeners: Set<(event: import('../types/events.js').SnapshotSuppressedEvent) => void> = new Set();

  /**
   * Subscribers notified for listener attach / detach lifecycle. Errored
   * still routes through onSnapshotError (bridged to listener_errored
   * in SandboxImpl) so this channel only carries attach + detach.
   */
  private lifecycleListeners: Set<(event: import('../types/events.js').ListenerLifecycleEvent) => void> = new Set();

  /**
   * The user-origin op that's currently triggering a listener re-eval,
   * if any. Set by the execute / batch / transaction call sites
   * immediately before `notifyListenersForPaths`. Call sites use a
   * **save/restore** pattern — a listener callback may itself issue a
   * write, recursing through execute and setting up its own trigger; we
   * must put the outer trigger back when the nested call returns so the
   * remaining listeners in the outer fan-out still attribute correctly.
   *
   * Listener-origin RequestEvents copy this into `triggeredBy`. Undefined
   * for the initial-fire path and for deployRules re-evaluation.
   */
  private currentTrigger?: { method: string; path: string };

  /**
   * RULES-B11 — parsed-AST cache for the query-proof gate. The proof
   * needs the matched `list` rule's condition AST on EVERY list read;
   * re-parsing the (unchanging) rules source per read would be O(source)
   * on the listener hot path. Keyed on the exact source string so
   * `deployRules` / `seed` invalidate it for free.
   */
  private parsedRulesCache: { source: string; ast: FirestoreRules | null } | null = null;

  /**
   * Subscribers notified when a snapshot listener is marked errored
   * (Slice 7). Mirrors `denialListeners` but fires from the listener
   * dispatch path, not from one-shot operation evaluation. Two-level
   * model per source survey section 9: the listener's own `errorCallback`
   * receives the error AND every env-level subscriber receives it —
   * the playground subscribes here to surface stream errors as toasts
   * the same way it surfaces denials today.
   */
  private snapshotErrorListeners: Set<
    (err: FirestoreSimError, target: SnapshotTarget, listenerId: string) => void
  > = new Set();

  /**
   * Active `onSnapshot` listeners. Slice 1 — registry only; the dispatch
   * path is wired in Slices 2 (initial fire), 3 (change detection), and
   * 5 (transaction/batch deferral). Stored as a flat `Map<id, record>`
   * per the implementation plan; query-canonicalization-based dedup
   * (production's `EventManager` shape) is layered on later when caching
   * actually saves work — see source survey section 2 for the eventual target
   * shape. Each record carries its own target so future slices can scan
   * and group on demand without restructuring the registry first.
   */
  private snapshotListeners: Map<string, ListenerRecord> = new Map();
  private nextListenerId = 0;

  /**
   * Deferred listener deliveries — the shared delivery scheduler (items
   * 3 + 5). Production never invokes an `onSnapshot` callback synchronously
   * on the registering/writing stack: the initial snapshot arrives after
   * the listen round-trip (COMPAT firestore#80 — "asynchronous, never
   * during register"), and a local write's echo + server ack arrive on the
   * async event queue (firestore#85). The sandbox mirrors that by enqueuing
   * every user-facing delivery here and draining it off-stack, on a
   * `queueMicrotask` boundary — which satisfies the "asynchronous" contract
   * without a macrotask's extra latency (the prototype in the deep-divergence
   * review measured identical behavior for micro- vs macro-task deferral).
   *
   * Per-listener FIFO order is preserved: deliveries enqueued *during* a
   * drain — a callback that itself writes, or the item-3 metadata ack a
   * write echo schedules — are appended and drained in the same pass, so a
   * write settles fully before control returns to the microtask loop.
   */
  private deliveryQueue: Array<() => void> = [];
  private deliveryScheduled = false;

  constructor() {
    this.state = new LocalState();
    this.eventLog = new EventLog();
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
    this.rulesSource = DEFAULT_OPEN_RULES;
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
    this.denialListeners.add(cb);
    return () => { this.denialListeners.delete(cb); };
  }

  private emitDenial(err: FirestoreSimError): void {
    if (this.denialListeners.size === 0) return;
    for (const cb of this.denialListeners) {
      try { cb(err); } catch { /* ignore — see onDenial doc */ }
    }
  }

  /**
   * Subscribe to every evaluated op (issue #307). Returns an unsubscribe
   * fn. The emit sites in `execute`, `batch`, `silentReadDoc`,
   * `silentReadCollection` build the public-shape event lazily — when
   * no subscribers are attached, eval doesn't pay the allocation cost.
   */
  onRequest(cb: (event: import('../types/events.js').RequestEvent) => void): () => void {
    this.requestListeners.add(cb);
    return () => { this.requestListeners.delete(cb); };
  }

  /**
   * Subscribe to committed-write events. Internal — bridged to the
   * public `Sandbox.onEvent` channel by SandboxImpl. Fires AFTER the
   * keyspace applies the write; denied / rolled-back writes don't
   * emit here.
   */
  onWrite(cb: (event: import('../types/events.js').WriteSandboxEvent) => void): () => void {
    this.writeListeners.add(cb);
    return () => { this.writeListeners.delete(cb); };
  }

  /** Internal — bridge for sandbox-level `onEvent` to receive
   *  snapshot-delivery events. Fires after the user callback runs. */
  onSnapshotDelivery(cb: (event: import('../types/events.js').SnapshotDeliveryEvent) => void): () => void {
    this.deliveryListeners.add(cb);
    return () => { this.deliveryListeners.delete(cb); };
  }

  /** Internal bridge for snapshot_suppressed events — re-evals that
   *  didn't deliver because diffing found no observable change. */
  onSnapshotSuppressed(cb: (event: import('../types/events.js').SnapshotSuppressedEvent) => void): () => void {
    this.suppressedListeners.add(cb);
    return () => { this.suppressedListeners.delete(cb); };
  }

  /** Internal bridge for listener attach/detach lifecycle. Errored
   *  routes through onSnapshotError separately. */
  onListenerLifecycle(cb: (event: import('../types/events.js').ListenerLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(cb);
    return () => { this.lifecycleListeners.delete(cb); };
  }

  private emitSnapshotDelivery(input: {
    listenerId: string;
    target: import('../types/events.js').SnapshotDeliveryEvent['target'];
    auth: ListenerAuth;
    addedCount: number;
    modifiedCount: number;
    removedCount: number;
    size: number;
    sample?: { docs: Array<{ path: string; data: Record<string, unknown> | null }> };
    triggeredBy?: { method: string; path: string };
  }): void {
    if (this.deliveryListeners.size === 0) return;
    const event: import('../types/events.js').SnapshotDeliveryEvent = {
      kind: 'snapshot_delivery',
      id: nextRequestEventId().replace(/^req-/, 'snd-'),
      at: Date.now(),
      listenerId: input.listenerId,
      target: input.target,
      auth: input.auth
        ? { uid: input.auth.uid, ...(input.auth.token ? { token: input.auth.token } : {}) }
        : null,
      addedCount: input.addedCount,
      modifiedCount: input.modifiedCount,
      removedCount: input.removedCount,
      size: input.size,
      ...(input.sample ? { sample: input.sample } : {}),
      ...(input.triggeredBy ? { triggeredBy: input.triggeredBy } : {}),
    };
    for (const cb of this.deliveryListeners) {
      try { cb(event); } catch { /* swallow */ }
    }
  }

  private emitSnapshotSuppressed(input: {
    listenerId: string;
    target: import('../types/events.js').SnapshotSuppressedEvent['target'];
    auth: ListenerAuth;
    triggeredBy?: { method: string; path: string };
  }): void {
    if (this.suppressedListeners.size === 0) return;
    const event: import('../types/events.js').SnapshotSuppressedEvent = {
      kind: 'snapshot_suppressed',
      id: nextRequestEventId().replace(/^req-/, 'sup-'),
      at: Date.now(),
      listenerId: input.listenerId,
      target: input.target,
      auth: input.auth
        ? { uid: input.auth.uid, ...(input.auth.token ? { token: input.auth.token } : {}) }
        : null,
      reason: 'no-op',
      ...(input.triggeredBy ? { triggeredBy: input.triggeredBy } : {}),
    };
    for (const cb of this.suppressedListeners) {
      try { cb(event); } catch { /* swallow */ }
    }
  }

  private emitLifecycle(input: {
    phase: 'listener_attach' | 'listener_detach';
    listenerId: string;
    target: import('../types/events.js').ListenerLifecycleEvent['target'];
    auth: ListenerAuth;
  }): void {
    if (this.lifecycleListeners.size === 0) return;
    const event: import('../types/events.js').ListenerLifecycleEvent = {
      kind: input.phase,
      id: nextRequestEventId().replace(/^req-/, 'lc-'),
      at: Date.now(),
      listenerId: input.listenerId,
      target: input.target,
      auth: input.auth
        ? { uid: input.auth.uid, ...(input.auth.token ? { token: input.auth.token } : {}) }
        : null,
    };
    for (const cb of this.lifecycleListeners) {
      try { cb(event); } catch { /* swallow */ }
    }
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
  }): void {
    if (this.writeListeners.size === 0) return;
    const event: import('../types/events.js').WriteSandboxEvent = {
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
    };
    for (const cb of this.writeListeners) {
      try {
        const result = cb(event) as unknown;
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          (result as Promise<unknown>).catch(() => { /* see emitRequest doc */ });
        }
      } catch { /* see emitRequest doc */ }
    }
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
    if (this.requestListeners.size === 0) return;
    const event = buildRequestEvent(input);
    for (const cb of this.requestListeners) {
      try {
        const result = cb(event) as unknown;
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          (result as Promise<unknown>).catch(() => { /* see method doc */ });
        }
      } catch { /* see method doc */ }
    }
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
    this.snapshotErrorListeners.add(cb);
    return () => { this.snapshotErrorListeners.delete(cb); };
  }

  private emitSnapshotError(
    err: FirestoreSimError,
    target: SnapshotTarget,
    listenerId: string,
  ): void {
    if (this.snapshotErrorListeners.size === 0) return;
    for (const cb of this.snapshotErrorListeners) {
      try { cb(err, target, listenerId); } catch { /* ignore — see onSnapshotError doc */ }
    }
  }

  // ═══ Snapshot listeners (Slices 1+2) ═══

  /**
   * Register a snapshot listener. Returns an `Unsubscribe` function
   * matching the Web SDK's contract — a zero-arg call that detaches
   * the listener. Idempotent: calling the returned function more than
   * once after the first detach is a no-op.
   *
   * Slice 2: fires the **initial snapshot** synchronously after the
   * record is registered. The current matching docs are read under
   * `auth`'s rules unless `bypassRules` pins the admin path — denied reads
   * invoke `errorCallback` and mark the listener `errored` (no further
   * notifications). Slice 3 will add
   * change-driven fires; Slice 5 batches them through `applyBatch`.
   *
   * `auth` is captured at registration so notifications later evaluate
   * rules under the auth that subscribed — not whatever auth happens
   * to be active when a write triggers the dispatch.
   */
  addSnapshotListener(
    target: SnapshotTarget,
    callback: SnapshotCallback,
    options: SnapshotListenerOptions = {},
    auth: ListenerAuth = null,
    errorCallback?: SnapshotErrorCallback,
    /**
     * `true` when the registering Firestore handle was a `sandbox-live`
     * (`getFirestore(sandbox)`) target — its identity follows
     * `sandbox.currentUser`, so this listener re-evaluates on a
     * `currentUser` change (see {@link reevaluateLiveListeners}).
     * `false` (default) for frozen-ctx (`getFirestore(ctx)`) listeners,
     * which stay pinned to the auth they captured at registration.
     */
    followsCurrentUser = false,
    /** Rules-bypassing admin listener. */
    bypassRules = false,
  ): () => void {
    const id = String(this.nextListenerId++);
    const record: ListenerRecord = {
      id,
      target,
      callback,
      auth,
      followsCurrentUser,
      bypassRules,
      options,
      currentSnapshot: undefined,
      errored: false,
      ...(errorCallback ? { errorCallback } : {}),
    };
    this.snapshotListeners.set(id, record);

    // Issue #307 — emit lifecycle BEFORE the initial fire so observers
    // see attach → delivery in causal order.
    this.emitLifecycle({
      phase: 'listener_attach',
      listenerId: id,
      target: target.kind === 'doc'
        ? { kind: 'doc', path: target.path }
        : { kind: 'query', collection: target.collection },
      auth,
    });

    // Items 3 + 5 — the initial snapshot is delivered off-stack through the
    // delivery scheduler, never synchronously during register. Production's
    // event queue schedules even a *cached* initial event asynchronously
    // (COMPAT firestore#80: "asynchronous, never during register"), so the
    // register-then-read-synchronously agent pattern that returns `undefined`
    // on prod also returns `undefined` here — the sandbox no longer trains
    // users into a pattern prod breaks. The unsubscribe-before-drain guard
    // mirrors prod: a listener detached before its first fire never sees one.
    // Errors still route through the listener's `errorCallback` (inside
    // `fireInitialSnapshot`), never thrown out of `addSnapshotListener`.
    this.scheduleDelivery(() => {
      if (!this.snapshotListeners.has(id)) return;
      this.fireInitialSnapshot(record);
    });

    return () => {
      const stillRegistered = this.snapshotListeners.has(id);
      this.snapshotListeners.delete(id);
      // Only emit detach if the listener was actually registered when
      // the unsubscribe was called. Idempotent calls and listeners
      // dropped by `reset()` don't double-emit.
      if (stillRegistered) {
        this.emitLifecycle({
          phase: 'listener_detach',
          listenerId: id,
          target: target.kind === 'doc'
            ? { kind: 'doc', path: target.path }
            : { kind: 'query', collection: target.collection },
          auth,
        });
      }
    };
  }

  /**
   * Compute and deliver the initial snapshot for a freshly-registered
   * listener. Reads under the listener's `auth` and respects the
   * deployed rules — denied reads route to `errorCallback` and mark
   * the record `errored`. Splits doc vs query targets along the same
   * seam {@link execute} uses, but does **not** append to the event
   * log: listener reads are bookkeeping, not user-visible operations,
   * and would otherwise drown the event log under any non-trivial UI.
   */
  private fireInitialSnapshot(record: ListenerRecord): void {
    if (record.target.kind === 'doc') {
      const result = this.silentReadDoc(
        record.target.path,
        record.auth,
        record.bypassRules,
      );
      if (!result.allowed) {
        this.markErrored(record, result.error);
        return;
      }
      const snap = buildDocumentSnapshot(record.target.path, result.data);
      record.currentSnapshot = snap;
      record.currentDocData = result.data;
      try {
        record.callback(snap);
      } catch {
        /* swallow — same rationale as emitDenial; a faulty consumer
         * callback must not destabilize the simulator. */
      }
      // Issue #307 — initial fire counts as a delivery. No triggeredBy
      // because there was no user op that caused this; the listener
      // just attached.
      this.emitSnapshotDelivery({
        listenerId: record.id,
        target: { kind: 'doc', path: record.target.path },
        auth: record.auth,
        addedCount: result.data !== null ? 1 : 0,
        modifiedCount: 0,
        removedCount: 0,
        size: result.data !== null ? 1 : 0,
        sample: { docs: [{ path: record.target.path, data: result.data }] },
      });
      return;
    }

    // Query target.
    const result = this.silentReadCollection(
      record.target.collection,
      record.auth,
      record.target.constraints,
      record.bypassRules,
    );
    if (!result.allowed) {
      this.markErrored(record, result.error);
      return;
    }
    const snap = buildQuerySnapshot(
      { path: record.target.collection },
      result.docs,
      { excludesMetadataChanges: !record.options.includeMetadataChanges },
    );
    record.currentSnapshot = snap;
    record.currentDocs = result.docs;
    try {
      record.callback(snap);
    } catch {
      /* swallow — see above */
    }
    this.emitSnapshotDelivery({
      listenerId: record.id,
      target: { kind: 'query', collection: record.target.collection },
      auth: record.auth,
      // Initial fire: every doc surfaces as `added`.
      addedCount: result.docs.length,
      modifiedCount: 0,
      removedCount: 0,
      size: result.docs.length,
      sample: { docs: result.docs.map((d) => ({ path: d.path, data: d.data })) },
    });
  }

  // ═══ Delivery scheduler (items 3 + 5) ═══

  /**
   * Enqueue a listener delivery and ensure an off-stack drain is pending.
   * See {@link deliveryQueue}.
   */
  private scheduleDelivery(deliver: () => void): void {
    this.deliveryQueue.push(deliver);
    if (this.deliveryScheduled) return;
    this.deliveryScheduled = true;
    queueMicrotask(() => this.drainDeliveries());
  }

  /**
   * Enqueue a write-driven delivery, restoring the triggering op while it
   * runs so listener-origin RequestEvents / delivery events still attribute
   * to the write (`triggeredBy`) even though the callback now fires off the
   * writing stack. See {@link currentTrigger}.
   */
  private scheduleTriggeredDelivery(
    trigger: { method: string; path: string } | undefined,
    deliver: () => void,
  ): void {
    this.scheduleDelivery(() => {
      const prevTrigger = this.currentTrigger;
      this.currentTrigger = trigger;
      try {
        deliver();
      } finally {
        this.currentTrigger = prevTrigger;
      }
    });
  }

  /**
   * Drain queued deliveries in FIFO order. A delivery may enqueue more (a
   * callback that writes; the item-3 metadata ack a write echo schedules) —
   * those are appended and drained in the same pass.
   */
  private drainDeliveries(): void {
    this.deliveryScheduled = false;
    while (this.deliveryQueue.length > 0) {
      const deliver = this.deliveryQueue.shift()!;
      deliver();
    }
  }

  /**
   * Synchronously deliver all pending snapshot fires. Test-only seam:
   * production consumers observe deliveries via the microtask drain, but a
   * synchronous test body calls this to settle the queue deterministically
   * before asserting fire counts / snapshot contents. Idempotent — a no-op
   * on an empty queue, and safe when a microtask drain is also pending (that
   * drain then finds the queue already empty).
   */
  flushListeners(): void {
    this.drainDeliveries();
  }

  // ═══ Slice 3 — change-driven notification ═══

  /**
   * Walk every active snapshot listener and fire those whose target
   * intersects `touchedPaths`. Called by the write-path commit hooks
   * — `execute` (single write) and the two `applyBatch` call-sites
   * (batch + transaction). Suppresses no-op snapshots per findings section 5
   * (View-level suppression rather than `isEqual`): doc listeners only
   * fire when the underlying data shape changes; query listeners only
   * fire when the change list is non-empty.
   *
   * Iteration walks a snapshotted list of records — a callback is
   * allowed to add or remove listeners (StrictMode + HMR routinely do)
   * and we must not iterate a mutating Map.
   *
   * Items 3 + 5 — each per-listener fire is enqueued on the delivery
   * scheduler rather than run inline, so the write echo lands off the
   * writing stack (like prod's async event queue) and stays ordered behind
   * any still-pending initial fire for the same listener. The errored /
   * unsubscribe checks are re-run at delivery time because a listener may
   * detach or error between this write and the drain.
   */
  private notifyListenersForPaths(touchedPaths: ReadonlySet<string>): void {
    if (touchedPaths.size === 0) return;
    if (this.snapshotListeners.size === 0) return;
    // Capture the triggering op now; the deliveries run off-stack, by which
    // time `currentTrigger` has been restored to the microtask loop's state.
    const trigger = this.currentTrigger;
    const records = Array.from(this.snapshotListeners.values());
    for (const record of records) {
      this.scheduleTriggeredDelivery(trigger, () => {
        if (!this.snapshotListeners.has(record.id)) return;
        if (record.errored) return;
        if (record.target.kind === 'doc') {
          this.notifyDocListener(record, touchedPaths);
        } else {
          this.notifyQueryListener(record, touchedPaths);
        }
      });
    }
  }

  private notifyDocListener(record: ListenerRecord, touchedPaths: ReadonlySet<string>): void {
    if (record.target.kind !== 'doc') return;
    if (!touchedPaths.has(record.target.path)) return;

    const result = this.silentReadDoc(
      record.target.path,
      record.auth,
      record.bypassRules,
    );
    if (!result.allowed) {
      this.markErrored(record, result.error);
      return;
    }

    // Suppression: identical underlying data (existence + shape) ⇒ no
    // fire. Production's View suppresses by absence rather than by
    // building-then-comparing snapshots; we approximate the same shape
    // by comparing the raw data we'd hand to `buildDocumentSnapshot`.
    const prev = record.currentDocData ?? null;
    if (docDataEqual(prev, result.data)) {
      // Issue #307 — surface the suppressed re-eval so inspector-style
      // consumers can answer "the listener woke up but had nothing to
      // deliver".
      this.emitSnapshotSuppressed({
        listenerId: record.id,
        target: { kind: 'doc', path: record.target.path },
        auth: record.auth,
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
      return;
    }

    // Item 3 — the local write echo carries hasPendingWrites:true (prod's
    // optimistic local fire, delivered before the server round-trip). The
    // settled server ack (hasPendingWrites:false) is scheduled below, but
    // only includeMetadataChanges listeners observe it — a default listener's
    // last-seen snapshot stays `pending:true` (COMPAT firestore#85).
    const path = record.target.path;
    const snap = buildDocumentSnapshot(path, result.data, SANDBOX_METADATA_PENDING);
    record.currentSnapshot = snap;
    record.currentDocData = result.data;
    // Compute change shape for the delivery event. Doc listeners deliver
    // exactly one of added / modified / removed per fire.
    const wasExists = prev !== null;
    const isExists = result.data !== null;
    const addedCount = !wasExists && isExists ? 1 : 0;
    const removedCount = wasExists && !isExists ? 1 : 0;
    const modifiedCount = wasExists && isExists ? 1 : 0;
    try {
      record.callback(snap);
    } catch {
      /* swallow — see fireInitialSnapshot doc */
    }
    // Emit delivery AFTER the user callback runs so subscribers see
    // the same ordering as the user code: callback first, observer second.
    this.emitSnapshotDelivery({
      listenerId: record.id,
      target: { kind: 'doc', path },
      auth: record.auth,
      addedCount,
      modifiedCount,
      removedCount,
      size: isExists ? 1 : 0,
      sample: { docs: [{ path, data: result.data }] },
      ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
    });
    this.scheduleDocMetadataAck(record, path, result.data);
  }

  /**
   * Item 3 — schedule the server-ack fire that follows a write echo. Only
   * fires for includeMetadataChanges listeners (default listeners never see
   * the metadata-only ack; their snapshot stays `pending:true`). Re-delivers
   * the just-echoed data with `hasPendingWrites:false`, as a metadata-only
   * change (no added/modified/removed). Rides the delivery scheduler so it
   * lands off the echo's stack, matching prod's async ack rather than a
   * synchronous same-tick fire. `data` is captured from the echo so a later
   * write can't retroactively change what this ack reports. COMPAT firestore#85.
   */
  private scheduleDocMetadataAck(
    record: ListenerRecord,
    path: string,
    data: DocumentData | null,
  ): void {
    if (!record.options.includeMetadataChanges) return;
    this.scheduleTriggeredDelivery(this.currentTrigger, () => {
      if (!this.snapshotListeners.has(record.id)) return;
      if (record.errored) return;
      const ack = buildDocumentSnapshot(path, data, SANDBOX_METADATA);
      record.currentSnapshot = ack;
      try {
        record.callback(ack);
      } catch {
        /* swallow — see fireInitialSnapshot doc */
      }
      this.emitSnapshotDelivery({
        listenerId: record.id,
        target: { kind: 'doc', path },
        auth: record.auth,
        addedCount: 0,
        modifiedCount: 0,
        removedCount: 0,
        size: data !== null ? 1 : 0,
        sample: { docs: [{ path, data }] },
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
    });
  }

  private notifyQueryListener(record: ListenerRecord, touchedPaths: ReadonlySet<string>): void {
    if (record.target.kind !== 'query') return;
    // Cheap pre-filter: if no touched path lives in this collection,
    // skip the rules eval entirely. {@link silentReadCollection}'s
    // query-proof gate handles read-side visibility; this filter is
    // purely a write-path optimization.
    if (!anyPathInCollection(touchedPaths, record.target.collection)) return;

    const result = this.silentReadCollection(
      record.target.collection,
      record.auth,
      record.target.constraints,
      record.bypassRules,
    );
    if (!result.allowed) {
      this.markErrored(record, result.error);
      return;
    }

    const collection = record.target.collection;
    const prevDocs = record.currentDocs ?? [];
    // Item 3 — the write echo carries hasPendingWrites:true; the settled ack
    // (scheduled below for includeMetadataChanges listeners) carries false.
    const snap = buildQuerySnapshot(
      { path: collection },
      result.docs,
      { excludesMetadataChanges: !record.options.includeMetadataChanges },
      prevDocs,
      SANDBOX_METADATA_PENDING,
    );
    // Suppression: empty change set ⇒ nothing observable changed for
    // this listener (e.g., a write that landed under a different
    // collection but tripped the cheap pre-filter, or a write whose
    // post-image equals its pre-image). Match findings section 5.
    const changes = snap.docChanges();
    if (changes.length === 0) {
      this.emitSnapshotSuppressed({
        listenerId: record.id,
        target: { kind: 'query', collection },
        auth: record.auth,
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
      return;
    }

    record.currentSnapshot = snap;
    record.currentDocs = result.docs;
    let addedCount = 0, modifiedCount = 0, removedCount = 0;
    for (const c of changes) {
      if (c.type === 'added') addedCount++;
      else if (c.type === 'modified') modifiedCount++;
      else if (c.type === 'removed') removedCount++;
    }
    try {
      record.callback(snap);
    } catch {
      /* swallow — see fireInitialSnapshot doc */
    }
    this.emitSnapshotDelivery({
      listenerId: record.id,
      target: { kind: 'query', collection },
      auth: record.auth,
      addedCount,
      modifiedCount,
      removedCount,
      size: result.docs.length,
      sample: { docs: result.docs.map((d) => ({ path: d.path, data: d.data })) },
      ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
    });
    this.scheduleQueryMetadataAck(record, collection, result.docs);
  }

  /**
   * Item 3 — query counterpart of {@link scheduleDocMetadataAck}. Re-delivers
   * the echoed doc set with `hasPendingWrites:false` as a metadata-only change
   * (no added/modified/removed — `prevDocs` equals the current docs), for
   * includeMetadataChanges listeners only. COMPAT firestore#85.
   */
  private scheduleQueryMetadataAck(
    record: ListenerRecord,
    collection: string,
    docs: { path: string; data: DocumentData }[],
  ): void {
    if (!record.options.includeMetadataChanges) return;
    this.scheduleTriggeredDelivery(this.currentTrigger, () => {
      if (!this.snapshotListeners.has(record.id)) return;
      if (record.errored) return;
      const ack = buildQuerySnapshot(
        { path: collection },
        docs,
        { excludesMetadataChanges: false },
        docs,
        SANDBOX_METADATA,
      );
      record.currentSnapshot = ack;
      try {
        record.callback(ack);
      } catch {
        /* swallow — see fireInitialSnapshot doc */
      }
      this.emitSnapshotDelivery({
        listenerId: record.id,
        target: { kind: 'query', collection },
        auth: record.auth,
        addedCount: 0,
        modifiedCount: 0,
        removedCount: 0,
        size: docs.length,
        sample: { docs: docs.map((d) => ({ path: d.path, data: d.data })) },
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
    });
  }

  /**
   * Run a `get` through the rules without touching the event log.
   * Returns the read shape used by listener-snapshot construction.
   *
   * Throws `SimulatorUnsupportedError` on UNSUPPORTED — same loud
   * surface as {@link execute}; the caller is then responsible for
   * propagating it. Listener-init paths catch nothing: an unsupported
   * rule is a sandbox limitation worth surfacing to the agent
   * verbatim, not silently rerouting through `errorCallback`.
   */
  private silentReadDoc(
    path: string,
    auth: ListenerAuth,
    bypassRules = false,
  ): { allowed: true; data: DocumentData | null } | { allowed: false; error: FirestoreSimError } {
    if (bypassRules) {
      const data = this.state.get(path);
      this.emitRequest({
        at: Date.now(),
        evalMs: 0,
        method: 'get',
        path,
        auth,
        result: 'allow',
        debugMessages: ['admin lens — rules bypassed'],
        origin: 'admin',
        resourceBefore: { data, exists: data !== null },
        detail: { admin: true },
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
      return { allowed: true, data };
    }
    const readServerTime = Timestamp.fromMillis(Date.now());
    const testCase = this.buildTestCase({ method: 'get', path, auth }, readServerTime);
    // Issue #307 — time the simulate call for listener-origin RequestEvents.
    const evalAt = Date.now();
    const evalStart = performance.now();
    const simResult = this.simulator.simulate(this.rulesSource, [testCase], {
      getDoc: (path) => this.state.get(path),
    });
    const evalMs = performance.now() - evalStart;
    if (!simResult.success) {
      this.emitRequest({
        at: evalAt, evalMs, method: 'get', path, auth, result: 'deny',
        debugMessages: [`Simulation error: ${simResult.error.message}`],
        origin: 'listener',
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
      return {
        allowed: false,
        error: makeError('permission-denied', `get ${path} simulator error`, {
          request: { method: 'get', path, auth },
        }),
      };
    }
    const result = simResult.data.results[0]!;
    if (result.state === 'UNSUPPORTED') {
      this.emitRequest({
        at: evalAt, evalMs, method: 'get', path, auth, result: 'unsupported',
        debugMessages: renderLegacyDebugMessages(result), origin: 'listener',
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
      throw new SimulatorUnsupportedError(
        unsupportedMessage('get', path, renderLegacyDebugMessages(result)),
        'get', path, renderLegacyDebugMessages(result),
      );
    }
    const isAllowed = result.state === 'PASSED';
    const data = this.state.get(path);
    this.emitRequest({
      at: evalAt, evalMs, method: 'get', path, auth,
      result: isAllowed ? 'allow' : 'deny',
      debugMessages: renderLegacyDebugMessages(result),
      evaluatedRule: projectEvaluatedRule(result), origin: 'listener',
      resourceBefore: { data, exists: data !== null },
      ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
    });
    if (!isAllowed) {
      return {
        allowed: false,
        error: makeError('permission-denied', `get ${path} denied by rules`, {
          request: { method: 'get', path, auth },
          resource: { data, exists: data !== null },
        }),
      };
    }
    return { allowed: true, data };
  }

  /**
   * RULES-B11 — the parsed rules AST for the query-proof gate, cached
   * per source string. `null` when the source doesn't parse (the
   * simulate() call then reports the failure on its own).
   */
  private rulesAst(): FirestoreRules | null {
    if (this.parsedRulesCache?.source !== this.rulesSource) {
      this.parsedRulesCache = {
        source: this.rulesSource,
        ast: parseToAST(this.rulesSource),
      };
    }
    return this.parsedRulesCache.ast;
  }

  /**
   * Collection variant of {@link silentReadDoc}. Returns docs in
   * `LocalState.list` order. Phantom parents are dropped here;
   * agent-visible snapshots only contain real docs.
   *
   * **RULES-B11 — query-proof enforcement ("rules are not filters").**
   * Production never filters a query down to the readable subset: the
   * `list` rule is proven against the query's constraints, and an
   * unprovable query is DENIED whole (firebase.google.com/docs/firestore/
   * security/rules-query). The gate here:
   *   1. `proveListQuery` decides PROVABLE / UNPROVABLE from the matched
   *      `list`/`read` rule conditions + the structured `where`
   *      constraints carried on the applier (FS-B2 threading).
   *   2. UNPROVABLE → one deny request event + `permission-denied` for
   *      the WHOLE query — no silent truncation.
   *   3. PROVABLE → the ordinary simulate() run evaluates the residual
   *      (auth / time / request.query) condition; doc-data conjuncts the
   *      query pins are evaluated against the synthetic representative
   *      resource (see `list-query-proof.ts`).
   * Per-doc `get` rules do NOT filter query results — prod queries are
   * governed by the `list` rule alone (the old per-doc filter loop was
   * the rules-as-filters divergence this replaces). UNSUPPORTED still
   * bubbles through unchanged.
   */
  private silentReadCollection(
    collection: string,
    auth: ListenerAuth,
    constraints?: QueryConstraintApplier,
    bypassRules = false,
  ): { allowed: true; docs: { path: string; data: DocumentData }[] } | { allowed: false; error: FirestoreSimError } {
    // List rules are defined at the document-match level, so the
    // simulator expects a document-style path with a synthetic
    // placeholder segment (matches the convention used by
    // local-env-reads tests). Without it, a `list` against a bare
    // collection path falls through to no match and is denied.
    const listPath = `${collection}/__listPlaceholder__`;
    const structured: QueryConstraints = constraints?.structured ?? {};
    const requestQuery = listQueryFromStructured(structured);
    const requestDetail = {
      ...(bypassRules ? { admin: true } : {}),
      ...(requestQuery ? { query: requestQuery } : {}),
    };
    const detail = Object.keys(requestDetail).length > 0 ? requestDetail : undefined;
    const evalAt = Date.now();
    if (bypassRules) {
      const docs = this.state.list(collection)
        .filter((document) => !document.phantom)
        .map((document) => ({ path: document.path, data: document.data }));
      const constrained = constraints ? constraints(docs) : docs;
      this.emitRequest({
        at: evalAt,
        evalMs: 0,
        method: 'list',
        path: collection,
        auth,
        result: 'allow',
        debugMessages: ['admin lens — rules bypassed'],
        origin: 'admin',
        ...(detail ? { detail } : {}),
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
      return { allowed: true, docs: constrained };
    }
    const readServerTime = Timestamp.fromMillis(Date.now());
    const evalStart = performance.now();
    // ── RULES-B11 gate: prove the query before evaluating the rule. ──
    const proof = proveListQuery(this.rulesAst(), listPath, auth, structured);
    if (proof.kind === 'unprovable') {
      const evalMs = performance.now() - evalStart;
      const message = `list ${collection} denied: unprovable query — rules are not filters (${proof.reason})`;
      this.emitRequest({
        at: evalAt, evalMs, method: 'list', path: collection, auth, result: 'deny',
        debugMessages: [message], origin: 'listener',
        ...(detail ? { detail } : {}),
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
      return {
        allowed: false,
        error: makeError('permission-denied', message, {
          request: { method: 'list', path: collection, auth },
        }),
      };
    }
    const testCase = this.buildTestCase({ method: 'list', path: listPath, auth }, readServerTime);
    this.applyListProof(testCase, proof, structured);
    // Issue #307 — time the outer list eval.
    const simResult = this.simulator.simulate(this.rulesSource, [testCase], {
      getDoc: (path) => this.state.get(path),
    });
    const evalMs = performance.now() - evalStart;
    if (!simResult.success) {
      this.emitRequest({
        at: evalAt, evalMs, method: 'list', path: collection, auth, result: 'deny',
        debugMessages: [`Simulation error: ${simResult.error.message}`],
        origin: 'listener',
        ...(detail ? { detail } : {}),
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
      return {
        allowed: false,
        error: makeError('permission-denied', `list ${collection} simulator error`, {
          request: { method: 'list', path: collection, auth },
        }),
      };
    }
    const result = simResult.data.results[0]!;
    if (result.state === 'UNSUPPORTED') {
      this.emitRequest({
        at: evalAt, evalMs, method: 'list', path: collection, auth, result: 'unsupported',
        debugMessages: renderLegacyDebugMessages(result), origin: 'listener',
        ...(detail ? { detail } : {}),
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
      throw new SimulatorUnsupportedError(
        unsupportedMessage('list', collection, renderLegacyDebugMessages(result)),
        'list', collection, renderLegacyDebugMessages(result),
      );
    }
    if (result.state !== 'PASSED') {
      this.emitRequest({
        at: evalAt, evalMs, method: 'list', path: collection, auth, result: 'deny',
        debugMessages: renderLegacyDebugMessages(result),
        evaluatedRule: projectEvaluatedRule(result), origin: 'listener',
        ...(detail ? { detail } : {}),
        ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
      });
      return {
        allowed: false,
        error: makeError('permission-denied', `list ${collection} denied by rules`, {
          request: { method: 'list', path: collection, auth },
        }),
      };
    }
    // One allow event for the whole list — one query listener fire =
    // one event in the consumer's stream.
    this.emitRequest({
      at: evalAt, evalMs, method: 'list', path: collection, auth, result: 'allow',
      debugMessages: renderLegacyDebugMessages(result),
      evaluatedRule: projectEvaluatedRule(result), origin: 'listener',
      ...(detail ? { detail } : {}),
      ...(this.currentTrigger ? { triggeredBy: this.currentTrigger } : {}),
    });
    // RULES-B11 — the proof + list-rule eval decided the WHOLE query; no
    // per-doc `get` re-evaluation. Production queries are governed by the
    // `list` rule alone — a per-doc filter here was the rules-as-filters
    // divergence (docs the user couldn't `get` were silently omitted
    // where prod would have returned them, list rule permitting).
    const docs = this.state.list(collection)
      .filter((d) => !d.phantom)
      .map((d) => ({ path: d.path, data: d.data }));
    // FS-B2 — apply the query's where / orderBy / cursor / limit
    // constraints, so a filtered listener delivers the same membership a
    // one-shot `getDocs(query(...))` would (instead of the whole
    // collection). The proof above guaranteed the rule holds for every
    // doc the constraints admit.
    const constrained = constraints ? constraints(docs) : docs;
    return { allowed: true, docs: constrained };
  }

  /**
   * RULES-B11 — apply a PROVABLE proof to the `list` test case before the
   * residual simulate() run:
   *   - inject the synthetic representative `resource` (the fields the
   *     query pins with `where(field, ==, value)`) so doc-data conjuncts
   *     evaluate against what every returnable doc is guaranteed to carry;
   *   - populate `request.query` from the structured constraints so rules
   *     reading `request.query.limit` / `.orderBy` see the real values.
   */
  private applyListProof(
    testCase: TestCase,
    proof: { kind: 'provable'; syntheticResource?: Record<string, unknown> } | { kind: 'no-rule' },
    structured: QueryConstraints,
  ): void {
    if (proof.kind === 'provable' && proof.syntheticResource) {
      testCase.resource = proof.syntheticResource;
    }
    if (structured.limit != null || structured.offset != null || structured.orderBy != null) {
      testCase.query = {
        ...(structured.limit != null ? { limit: structured.limit } : {}),
        ...(structured.offset != null ? { offset: structured.offset } : {}),
        ...(structured.orderBy != null ? { orderBy: structured.orderBy } : {}),
      };
    }
  }

  /**
   * Mark a listener as errored and fan the error out to two channels:
   *   1. The listener's own `errorCallback` (per-listener handler the
   *      Web SDK consumer registered via `onSnapshot(next, error)`).
   *   2. Every env-level `onSnapshotError` subscriber (Slice 7) — the
   *      playground UI surfaces stream errors here without each
   *      listener needing to register its own toast handler.
   *
   * Fan-out is unconditional even when `errorCallback` is missing: the
   * env-level channel is the catch-all so the host environment can
   * surface errors from listeners that didn't supply their own handler.
   */
  private markErrored(record: ListenerRecord, error: FirestoreSimError): void {
    record.errored = true;
    this.emitSnapshotError(error, record.target, record.id);
    if (!record.errorCallback) return;
    try {
      record.errorCallback(error);
    } catch {
      /* see emitDenial doc */
    }
  }

  /**
   * Test seam — exposes registry size without leaking the records.
   * Slice 2+ may add a richer accessor when the diff path needs to
   * iterate; for now this is enough to assert add/remove correctness.
   */
  getSnapshotListenerCount(): number {
    return this.snapshotListeners.size;
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
   * data state (`state` / `eventLog` / `rulesSource`) — `dispose()` is
   * about *callback ownership*, not data lifecycle. Construct a fresh
   * `LocalEnvironment` (or call `seed()`) to reset data.
   */
  dispose(): void {
    this.snapshotListeners.clear();
    this.denialListeners.clear();
    this.snapshotErrorListeners.clear();
    this.requestListeners.clear();
    this.writeListeners.clear();
    this.deliveryListeners.clear();
    this.suppressedListeners.clear();
    this.lifecycleListeners.clear();
    // Drop any queued-but-undelivered fires so a disposed env can't invoke
    // an outgoing consumer's callback on a later microtask drain.
    this.deliveryQueue.length = 0;
    this.deliveryScheduled = false;
  }

  /** Seed the environment with rules and initial data. */
  seed(options: {
    rules: string;
    documents?: Record<string, DocumentData>;
    baseDocuments?: Record<string, DocumentData>;
  }): LintResult {
    this.rulesSource = options.rules;
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
    // Lint is *diagnosis*, not enforcement. The dev-loop sandbox
    // installs whatever the caller asks for; the production deploy
    // gate (before `firebase deploy`) re-lints at stricter severity and
    // refuses to ship genuinely bad rules. Callers that care about
    // the lint result still get it back; the `sandbox_inspect`
    // MCP tool surfaces it for agents.
    this.rulesSource = source;
    this.reEvaluateAllListeners();
    return lint;
  }

  /**
   * Walk every active listener and recompute its snapshot under the
   * current rules. Called by {@link deployRules} after a successful
   * rules swap (Slice 6 section 4.1). Iteration follows the same
   * snapshot-then-skip-orphans pattern as {@link notifyListenersForPaths}
   * — a callback may add or remove listeners (StrictMode + HMR both
   * routinely do this), and the dispatch loop must not iterate a
   * mutating Map.
   */
  private reEvaluateAllListeners(): void {
    if (this.snapshotListeners.size === 0) return;
    const records = Array.from(this.snapshotListeners.values());
    for (const record of records) {
      if (!this.snapshotListeners.has(record.id)) continue;
      if (record.target.kind === 'doc') {
        this.reEvaluateDocListener(record);
      } else {
        this.reEvaluateQueryListener(record);
      }
    }
  }

  /**
   * Re-evaluate every LIVE listener against a new session auth.
   *
   * Called when the sandbox's `currentUser` changes (sign-out / sign-in
   * as a different user). Production re-establishes the listen stream on
   * a session auth change — an auth-gated listener loses access on
   * sign-out and re-reads under the new identity on sign-in. The sandbox
   * matches that here: for each listener with `followsCurrentUser`, we
   * set `record.auth = newAuth` and re-run the SAME per-listener
   * evaluation `deployRules` uses ({@link reEvaluateDocListener} /
   * {@link reEvaluateQueryListener}) — which re-reads under the new auth
   * and flips allowed↔denied (delivering a fresh snapshot, or marking
   * the listener errored with `permission-denied` when the new auth
   * can't read).
   *
   * Frozen-ctx listeners (`followsCurrentUser === false`) are left
   * untouched — they stay pinned to the identity chosen at
   * `getFirestore(ctx)` time. WRITE-driven re-eval is unaffected: a
   * write by another user still re-evaluates each listener against ITS
   * OWN captured `auth` (this method only runs on auth change, and only
   * touches live listeners' captured auth).
   *
   * No-op when there are no live listeners. Iteration follows the same
   * snapshot-then-skip-orphans pattern as {@link notifyListenersForPaths}
   * — a callback may add or remove listeners during dispatch.
   */
  reevaluateLiveListeners(newAuth: ListenerAuth): void {
    if (this.snapshotListeners.size === 0) return;
    const records = Array.from(this.snapshotListeners.values());
    for (const record of records) {
      if (!record.followsCurrentUser) continue;
      if (!this.snapshotListeners.has(record.id)) continue;
      // Re-capture the session's new auth, then re-read under it. This is
      // the live-listener counterpart to prod re-establishing the stream
      // under the new identity.
      record.auth = newAuth;
      if (record.target.kind === 'doc') {
        this.reEvaluateDocListener(record);
      } else {
        this.reEvaluateQueryListener(record);
      }
    }
  }

  /**
   * Doc-listener re-evaluation. Three flip cases matter:
   *   - Allowed → denied: mark errored (unless already errored, in which
   *     case the error is not re-delivered — matches production's
   *     once-per-stream error contract).
   *   - Errored → allowed: clear `errored` and fire as an initial
   *     snapshot (the listener gets a fresh baseline; suppression cannot
   *     apply because there is no comparable `currentDocData` from the
   *     errored state).
   *   - Allowed → allowed: behaves like a write-driven re-fire — diff
   *     against `currentDocData` and suppress if unchanged.
   */
  private reEvaluateDocListener(record: ListenerRecord): void {
    if (record.target.kind !== 'doc') return;
    const result = this.silentReadDoc(
      record.target.path,
      record.auth,
      record.bypassRules,
    );
    if (!result.allowed) {
      if (record.errored) return;
      this.markErrored(record, result.error);
      return;
    }
    if (record.errored) {
      record.errored = false;
      const snap = buildDocumentSnapshot(record.target.path, result.data);
      record.currentSnapshot = snap;
      record.currentDocData = result.data;
      try {
        record.callback(snap);
      } catch {
        /* swallow — see fireInitialSnapshot doc */
      }
      return;
    }
    const prev = record.currentDocData ?? null;
    if (docDataEqual(prev, result.data)) return;
    const snap = buildDocumentSnapshot(record.target.path, result.data);
    record.currentSnapshot = snap;
    record.currentDocData = result.data;
    try {
      record.callback(snap);
    } catch {
      /* swallow — see fireInitialSnapshot doc */
    }
  }

  /**
   * Query-listener re-evaluation. Flip semantics mirror the doc path:
   * {@link silentReadCollection} re-runs the query-proof gate + `list`
   * rule under the new rules — a query that flipped unprovable/denied
   * surfaces as a stream error, one that flipped allowed re-delivers,
   * and the diff against `currentDocs` is computed by the same
   * `buildQuerySnapshot` path the write-driven notifier uses.
   */
  private reEvaluateQueryListener(record: ListenerRecord): void {
    if (record.target.kind !== 'query') return;
    const result = this.silentReadCollection(
      record.target.collection,
      record.auth,
      record.target.constraints,
      record.bypassRules,
    );
    if (!result.allowed) {
      if (record.errored) return;
      this.markErrored(record, result.error);
      return;
    }
    if (record.errored) {
      record.errored = false;
      // No prevDocs — every readable doc surfaces as `added`, matching
      // initial-fire semantics. The errored state had no comparable
      // baseline, so a clean reset is the correct contract.
      const snap = buildQuerySnapshot(
        { path: record.target.collection },
        result.docs,
        { excludesMetadataChanges: !record.options.includeMetadataChanges },
      );
      record.currentSnapshot = snap;
      record.currentDocs = result.docs;
      try {
        record.callback(snap);
      } catch {
        /* swallow — see fireInitialSnapshot doc */
      }
      return;
    }
    const prevDocs = record.currentDocs ?? [];
    const snap = buildQuerySnapshot(
      { path: record.target.collection },
      result.docs,
      { excludesMetadataChanges: !record.options.includeMetadataChanges },
      prevDocs,
    );
    const changes = snap.docChanges();
    if (changes.length === 0) return;
    record.currentSnapshot = snap;
    record.currentDocs = result.docs;
    try {
      record.callback(snap);
    } catch {
      /* swallow — see fireInitialSnapshot doc */
    }
  }

  /** Get current rules source. */
  getRules(): string {
    return this.rulesSource;
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
   * surfaces. **Unlike {@link listDocuments} this evaluates security
   * rules** (FS-B1 / RULES-B1): query reads must not be a silent total
   * bypass when single-doc reads (`DocumentReference.get`) are enforced.
   *
   * Semantics mirror the listener read path ({@link silentReadCollection}):
   *   1. RULES-B11 — prove the query against the matched `list` rule
   *      ("rules are not filters"): an unprovable query returns
   *      `{ allowed: false, error }` for the WHOLE query — the caller
   *      throws `permission-denied`. No silent truncation.
   *   2. Evaluate the `list` rule's residual condition once under `auth`
   *      (with the synthetic representative resource when the proof
   *      pinned doc-data fields). A denial (or simulator error) returns
   *      `{ allowed: false, error }`.
   *   3. On PASS every candidate is returned — production queries are
   *      governed by the `list` rule alone; per-doc `get` rules do not
   *      filter query results.
   *
   * `candidates` is supplied by the caller so collection-group queries
   * (whose candidate set is a cross-collection scan, not a single
   * `state.list`) can reuse the same enforcement. `listPath` is the
   * collection path the `list` rule evaluates against; for
   * collection-group reads the caller passes the group id's match path.
   * `query` is the structured `where`/`limit`/`orderBy` view the proof
   * consumes (the caller still applies the actual row filtering).
   *
   * Emits `origin: 'user'` request events (one per `list`) so inspector
   * consumers see query reads the same way they see writes. UNSUPPORTED
   * rules still bubble as {@link SimulatorUnsupportedError}.
   */
  readQueryCandidates(
    candidates: { path: string; data: DocumentData }[],
    listPath: string,
    auth: Operation['auth'],
    query?: QueryConstraints,
    bypassRules?: boolean,
  ): { allowed: true; docs: { path: string; data: DocumentData }[] } | { allowed: false; error: FirestoreSimError } {
    const structured: QueryConstraints = query ?? {};
    const requestQuery = listQueryFromStructured(structured);
    const requestDetail = {
      ...(bypassRules ? { admin: true } : {}),
      ...(requestQuery ? { query: requestQuery } : {}),
    };
    const detail = Object.keys(requestDetail).length > 0 ? requestDetail : undefined;
    // Studio admin lens (Gap #2): skip the query-proof gate + `list` rule
    // eval entirely and return every candidate. The proof model ("rules
    // are not filters") doesn't apply when rules are off — admin sees the
    // whole collection. Emit a single `allow` list event so the read still
    // shows up on the traffic log, mirroring the rule-allowed branch below.
    if (bypassRules) {
      this.emitRequest({
        at: Date.now(), evalMs: 0, method: 'list', path: listPath, auth, result: 'allow',
        debugMessages: ['admin lens — rules bypassed (Studio Gap #2)'], origin: 'user',
        ...(detail ? { detail } : {}),
      });
      return { allowed: true, docs: candidates };
    }
    const readServerTime = Timestamp.fromMillis(Date.now());
    // List rules match at the document level, so the `list` eval needs a
    // document-style path with a synthetic placeholder segment (same
    // convention as silentReadCollection).
    const placeholderPath = `${listPath}/__listPlaceholder__`;
    const evalAt = Date.now();
    const evalStart = performance.now();
    // ── RULES-B11 gate: prove the query before evaluating the rule. ──
    const proof = proveListQuery(this.rulesAst(), placeholderPath, auth, structured);
    if (proof.kind === 'unprovable') {
      const evalMs = performance.now() - evalStart;
      const message = `list ${listPath} denied: unprovable query — rules are not filters (${proof.reason})`;
      this.emitRequest({
        at: evalAt, evalMs, method: 'list', path: listPath, auth, result: 'deny',
        debugMessages: [message], origin: 'user',
        ...(detail ? { detail } : {}),
      });
      const error = makeError('permission-denied', message, {
        request: { method: 'list', path: listPath, auth },
      });
      this.emitDenial(error);
      return { allowed: false, error };
    }
    const testCase = this.buildTestCase({ method: 'list', path: placeholderPath, auth }, readServerTime);
    this.applyListProof(testCase, proof, structured);
    const simResult = this.simulator.simulate(this.rulesSource, [testCase], {
      getDoc: (path) => this.state.get(path),
    });
    const evalMs = performance.now() - evalStart;
    if (!simResult.success) {
      this.emitRequest({
        at: evalAt, evalMs, method: 'list', path: listPath, auth, result: 'deny',
        debugMessages: [`Simulation error: ${simResult.error.message}`], origin: 'user',
        ...(detail ? { detail } : {}),
      });
      return {
        allowed: false,
        error: makeError('permission-denied', `list ${listPath} simulator error`, {
          request: { method: 'list', path: listPath, auth },
        }),
      };
    }
    const result = simResult.data.results[0]!;
    if (result.state === 'UNSUPPORTED') {
      this.emitRequest({
        at: evalAt, evalMs, method: 'list', path: listPath, auth, result: 'unsupported',
        debugMessages: renderLegacyDebugMessages(result), origin: 'user',
        ...(detail ? { detail } : {}),
      });
      throw new SimulatorUnsupportedError(
        unsupportedMessage('list', listPath, renderLegacyDebugMessages(result)),
        'list', listPath, renderLegacyDebugMessages(result),
      );
    }
    if (result.state !== 'PASSED') {
      const debugMessages = renderLegacyDebugMessages(result);
      this.emitRequest({
        at: evalAt, evalMs, method: 'list', path: listPath, auth, result: 'deny',
        debugMessages, evaluatedRule: projectEvaluatedRule(result), origin: 'user',
        ...(detail ? { detail } : {}),
      });
      const error = makeError('permission-denied', `list ${listPath} denied by rules`, {
        request: { method: 'list', path: listPath, auth },
      });
      this.emitDenial(error);
      return { allowed: false, error };
    }
    // List allowed — one allow event covers the whole query read.
    this.emitRequest({
      at: evalAt, evalMs, method: 'list', path: listPath, auth, result: 'allow',
      debugMessages: renderLegacyDebugMessages(result),
      evaluatedRule: projectEvaluatedRule(result), origin: 'user',
      ...(detail ? { detail } : {}),
    });
    // RULES-B11 — no per-doc `get` filtering: the proof + list rule
    // decided the whole query (prod's model — the old per-doc loop was
    // the rules-as-filters divergence this replaces).
    return { allowed: true, docs: candidates };
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
    const priors: Record<string, DocumentData | null> = {};
    for (const path of paths) {
      const prior = this.state.get(path);
      priors[path] = prior ? { ...prior } : null;
    }
    return priors;
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
    this.notifyListenersForPaths(new Set([path]));
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
      this.notifyListenersForPaths(new Set([path]));
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
    if (bypassRules) {
      const results = testCases.map((tc) => adminBypassResult(tc.description));
      return {
        success: true,
        data: { passed: results.length, failed: 0, unsupported: 0, results },
      };
    }
    return this.simulator.simulate(this.rulesSource, testCases, {
      getDoc: (path) => this.state.get(path),
      ...(batchProjection ? { batchProjection } : {}),
    });
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
    const projection = new Map<string, DocumentData | null>();
    for (const tc of testCases) {
      if (tc.method === 'get' || tc.method === 'list') continue;
      projection.set(tc.path, tc.method === 'delete' ? null : (tc.data ?? {}));
    }
    return projection;
  }

  // ═══ Single operation (rules evaluated) ═══

  /** Execute a single operation. Rules are evaluated against local state.
   *  When `operation.bypassRules` is set, rule evaluation is skipped (admin
   *  lens — Studio Gap #2): the op is treated as ALLOW and routed through
   *  the same apply + emit path, so structural preconditions, events, and
   *  listeners behave exactly as a rule-allowed op would. */
  execute(operation: Operation): OperationResult {
    const { method, path, auth, data, autoId, requestTime: pinnedRequestTime, merge, bypassRules } = operation;
    const detail = bypassRules ? { admin: true } : undefined;

    // Reads — evaluate rules (denied reads return no data)
    if (method === 'get' || method === 'list') {
      // No data to resolve on reads, but still pin a serverTime so the
      // handler's `request.time` is deterministic relative to anything
      // observed by debug messages (Item 1).
      const readServerTime = Timestamp.fromMillis(Date.now());
      const testCase = this.buildTestCase(operation, readServerTime);
      // Issue #307 — time the simulate call for RequestEvent.evalMs.
      const evalAt = Date.now();
      const evalStart = performance.now();
      const simResult = this.runSimulate([testCase], bypassRules);
      const evalMs = performance.now() - evalStart;

      if (!simResult.success) {
        const event = this.eventLog.append({
          type: 'single', method, path, auth: auth ? { uid: auth.uid } : null,
          allowed: false, debugMessages: [`Simulation error: ${simResult.error.message}`],
        });
        // Issue #307 — simulator failures are still requests worth surfacing.
        this.emitRequest({
          at: evalAt, evalMs, method, path, auth, result: 'deny',
          debugMessages: [`Simulation error: ${simResult.error.message}`],
          origin: 'user',
          ...(detail ? { detail } : {}),
        });
        return { allowed: false, debugMessages: [simResult.error.message], event };
      }

      const result = simResult.data.results[0];
      if (result.state === 'UNSUPPORTED') {
        // Issue #307 — surface the eval-time event BEFORE throwing so
        // subscribers see the unsupported request alongside everything else.
        this.emitRequest({
          at: evalAt, evalMs, method, path, auth, result: 'unsupported',
          debugMessages: renderLegacyDebugMessages(result), origin: 'user',
          ...(detail ? { detail } : {}),
        });
        throw new SimulatorUnsupportedError(
          unsupportedMessage(method, path, renderLegacyDebugMessages(result)),
          method, path, renderLegacyDebugMessages(result),
        );
      }
      const isAllowed = result.state === 'PASSED';
      let readData: DocumentData | null | undefined;
      if (isAllowed) {
        readData = method === 'get' ? this.state.get(path) : this.state.list(path) as unknown as DocumentData;
      }

      const event = this.eventLog.append({
        type: 'single', method, path, auth: auth ? { uid: auth.uid } : null,
        allowed: isAllowed, debugMessages: renderLegacyDebugMessages(result),
      });

      // Item 6: reads only fail with permission-denied (no structural
      // not-found here — read of a missing doc is allowed-with-empty
      // by Firestore's contract; the rule decides visibility).
      const out: OperationResult = {
        allowed: isAllowed,
        data: isAllowed ? readData : undefined,
        debugMessages: renderLegacyDebugMessages(result),
        event,
      };
      if (!isAllowed) {
        // Item 6+: surface the eval-time request + resource on the
        // error so callers (sandbox / playground) can render a "why
        // did this denial happen" frame without re-deriving state.
        // For `list`, `resource` is intentionally omitted — the rule
        // evaluated against a collection, not a single doc.
        const reqRead: { method: 'get' | 'list'; path: string; auth: Operation['auth'] } =
          { method, path, auth };
        const resRead = method === 'get'
          ? { data: this.state.get(path), exists: this.state.get(path) !== null }
          : undefined;
        out.error = makeError(
          'permission-denied',
          `${method} ${path} denied by rules`,
          { request: reqRead, ...(resRead ? { resource: resRead } : {}) },
        );
        this.emitDenial(out.error);
      }
      // Issue #307 — emit the request event for every read, allow or deny.
      // resourceBefore mirrors what the rule saw on `resource`: populated for
      // `get` (the single doc); omitted for `list` (the rule didn't evaluate
      // against a single resource).
      this.emitRequest({
        at: evalAt, evalMs, method, path, auth,
        result: isAllowed ? 'allow' : 'deny',
        debugMessages: renderLegacyDebugMessages(result),
        evaluatedRule: projectEvaluatedRule(result),
        origin: 'user',
        ...(method === 'get'
          ? { resourceBefore: { data: this.state.get(path), exists: this.state.get(path) !== null } }
          : {}),
        ...(detail ? { detail } : {}),
      });
      return out;
    }

    // Write operations: evaluate rules. Capture only this path's prior state
    // for undo (single write touches one doc); `snapshot[path]` reads below stay
    // valid since the affected path is present, and undo stays O(1) not O(keyspace).
    const snapshot = this.capturePriors([path]);

    // Item 1: pin a single serverTime for this write. Both the resolver
    // (for any serverTimestamp sentinels in `data`) and the handler (for
    // `request.time`) must see field-equal values, otherwise rules like
    // `data.createdAt == request.time` flake on sub-millisecond drift.
    // Replay engine: `operation.requestTime` (when provided) overrides
    // Date.now() so the rule eval re-evaluates against the captured
    // wall-clock instant, eliminating time-drift on replay.
    const serverTime = pinnedRequestTime ?? Timestamp.fromMillis(Date.now());

    // Resolve the write payload BEFORE rule evaluation so rules see the
    // same shape storage will see (Item 0: write-boundary value-resolve).
    // LocalState will resolve again in applyWrite — converters are
    // required to be idempotent so the second pass is a no-op.
    //
    // Item 2: a converter (e.g., `increment` against a string-typed
    // prior) may throw. Surface as a denial — the agent's rule was
    // never given a chance to evaluate, but the operation is rejected.
    let resolvedData: DocumentData | undefined;
    try {
      resolvedData = data
        ? resolveValueTree({ ...data }, {
            path,
            method: method as ResolveMethod,
            prior: this.state.get(path),
            serverTime,
          })
        : data;
      // FS-B13 — `deleteField()` may only appear at the top level of an
      // `update` (whole field value or dot-path key); nested in a map
      // literal it is invalid and prod throws `invalid-argument` rather than
      // silently destroying the sibling map. (`set`/`create` without merge
      // resolve deleteField via partitionDeletes, which the dispatch below
      // handles; the merge path adds it to the field mask.)
      if (method === 'update' && resolvedData) {
        assertNoNestedDeleteField(resolvedData);
      }
    } catch (e) {
      const msg = (e as Error).message;
      const event = this.eventLog.append({
        type: 'single', method, path, auth: auth ? { uid: auth.uid } : null,
        data, allowed: false, priorDocs: snapshot,
        debugMessages: [`FieldValue resolve error: ${msg}`],
      });
      // Issue #307 — sentinel-resolution failures never reached the rules
      // engine but the user's op still produced a denial. evalMs is 0
      // because no simulate call happened.
      this.emitRequest({
        at: Date.now(), evalMs: 0, method, path, auth, result: 'deny',
        debugMessages: [`FieldValue resolve error: ${msg}`],
        ...(resolvedData ? { resourceData: resolvedData } : data ? { resourceData: data } : {}),
        resourceBefore: { data: snapshot[path] ?? null, exists: (snapshot[path] ?? null) !== null },
        origin: 'user',
        ...(detail ? { detail } : {}),
      });
      // Item 6: a sentinel-resolution throw maps to `invalid-argument`.
      // The admin SDK throws the same code when a FieldValue is malformed
      // for the prior data shape (e.g., increment on a non-number).
      return {
        allowed: false,
        debugMessages: [msg],
        event,
        error: makeError('invalid-argument', msg),
      };
    }

    const testCase = this.buildTestCase({ ...operation, data: resolvedData }, serverTime);
    // Issue #307 — time the simulate call for RequestEvent.evalMs.
    const evalAt = Date.now();
    const evalStart = performance.now();
    const simResult = this.runSimulate([testCase], bypassRules);
    const evalMs = performance.now() - evalStart;

    if (!simResult.success) {
      const event = this.eventLog.append({
        type: 'single', method, path, auth: auth ? { uid: auth.uid } : null,
        data: resolvedData, allowed: false, priorDocs: snapshot,
        debugMessages: [`Simulation error: ${simResult.error.message}`],
      });
      this.emitRequest({
        at: evalAt, evalMs, method, path, auth, result: 'deny',
        debugMessages: [`Simulation error: ${simResult.error.message}`],
        ...(data ? { resourceData: data } : {}),
        resourceBefore: { data: snapshot[path] ?? null, exists: (snapshot[path] ?? null) !== null },
        origin: 'user',
        ...(detail ? { detail } : {}),
      });
      // Item 6: a simulator-internal failure isn't a rules denial — map
      // it to invalid-argument so callers can distinguish "the rule
      // text or test case is wrong" from "the rule denied your write".
      return {
        allowed: false,
        debugMessages: [simResult.error.message],
        event,
        error: makeError('invalid-argument', simResult.error.message),
      };
    }

    const result = simResult.data.results[0];
    if (result.state === 'UNSUPPORTED') {
      this.emitRequest({
        at: evalAt, evalMs, method, path, auth, result: 'unsupported',
        debugMessages: renderLegacyDebugMessages(result),
        ...(data ? { resourceData: data } : {}),
        resourceBefore: { data: snapshot[path] ?? null, exists: (snapshot[path] ?? null) !== null },
        origin: 'user',
        ...(detail ? { detail } : {}),
      });
      throw new SimulatorUnsupportedError(
        unsupportedMessage(method, path, renderLegacyDebugMessages(result)),
        method, path, renderLegacyDebugMessages(result),
      );
    }
    // The simulation returns PASSED if the outcome matches the expectation.
    // Since we always set expectation to ALLOW, PASSED = allowed, FAILED = denied.
    let isAllowed = result.state === 'PASSED';
    let writeError: FirestoreSimError | null = null;

    if (isAllowed) {
      // Item 6: rules said yes; the keyspace may still say no (create-
      // already-exists, update/delete-missing). applyWrite returns the
      // structural error if so. Demote `allowed` and surface the code
      // — matches prod, which evaluates rules then preconditions and
      // returns the precondition error when it loses.
      writeError = this.applyWrite(method, path, resolvedData, merge);
      if (writeError) isAllowed = false;
    }

    const event = this.eventLog.append({
      type: 'single', method, path, auth: auth ? { uid: auth.uid } : null,
      data: resolvedData, allowed: isAllowed, priorDocs: isAllowed ? snapshot : undefined,
      debugMessages: renderLegacyDebugMessages(result),
    });

    const out: OperationResult = {
      allowed: isAllowed,
      debugMessages: renderLegacyDebugMessages(result),
      event,
    };
    if (!isAllowed) {
      // Structural error wins over a synthesized permission-denied —
      // it's the more specific signal. The structural-error branch
      // skips eval context (already-exists / not-found don't depend on
      // auth or resource shape).
      if (writeError) {
        out.error = writeError;
      } else {
        const priorDoc = snapshot[path] ?? null;
        // `set` denials surface under the rule clause that actually
        // ran — `create` for absent docs, `update` for existing ones
        // — so downstream consumers reading `error.request.method`
        // see the same value the rules engine saw.
        const evalMethod: 'create' | 'update' | 'delete' | 'get' | 'list' =
          method === 'set'
            ? (priorDoc !== null ? 'update' : 'create')
            : method;
        out.error = makeError(
          'permission-denied',
          `${method} ${path} denied by rules`,
          {
            request: {
              method: evalMethod,
              path,
              auth,
              ...(data ? { resourceData: data } : {}),
            },
            resource: { data: priorDoc, exists: priorDoc !== null },
          },
        );
        this.emitDenial(out.error);
      }
    }
    // Issue #307 — emit the request event before fan-out so subscribers
    // see the user-origin event before any listener-origin events that
    // notifyListenersForPaths will spawn. resourceAfter is the post-write
    // state when the write committed; for denials/structural-errors it's
    // the unchanged prior (matches what callers see on rollback).
    const priorDoc = snapshot[path] ?? null;
    const finalDoc = isAllowed ? this.state.get(path) : priorDoc;
    this.emitRequest({
      at: evalAt, evalMs, method, path, auth,
      result: isAllowed ? 'allow' : 'deny',
      debugMessages: renderLegacyDebugMessages(result),
      evaluatedRule: projectEvaluatedRule(result),
      ...(data ? { resourceData: data } : {}),
      resourceBefore: { data: priorDoc, exists: priorDoc !== null },
      ...(method !== 'delete'
        ? { resourceAfter: { data: finalDoc, exists: finalDoc !== null } }
        : { resourceAfter: { data: null, exists: false } }),
      origin: 'user',
      ...(detail ? { detail } : {}),
    });

    // Issue #307 — emit a committed-write event for the post-apply state.
    // Only fires on successful commit; rule denials and structural errors
    // surface as the request-deny RequestEvent above. `method` is already
    // narrowed to write verbs by this point (reads return earlier).
    if (isAllowed) {
      // Sentinels extracted from the PRE-resolution `data` (in scope from
      // the operation destructure); needed for replay so the engine can
      // re-issue the same FieldValue.* markers without consulting the
      // resolved values.
      const sentinels = data ? walkForSentinels(data) : undefined;
      // Auto-id signal: createWithAutoId sets operation.autoId=true.
      // The last path segment IS the minted id; capture it so replay
      // mints a fresh one.
      const mintedAutoId = autoId && method === 'create' ? path.split('/').pop() : undefined;
      this.emitWrite({
        method: method as 'create' | 'update' | 'set' | 'delete',
        path,
        auth,
        ...(method !== 'delete' && data ? { data } : {}),
        priorState: priorDoc,
        nextState: method === 'delete' ? null : finalDoc,
        ...(sentinels && sentinels.length > 0 ? { sentinels } : {}),
        ...(mintedAutoId ? { autoId: mintedAutoId } : {}),
        requestTime: serverTime,
        ...(detail ? { detail } : {}),
      });
    }

    // Slice 3 — fan out the write to any matching snapshot listeners.
    // Only fires on a successful commit; rule denials and structural
    // errors leave state unchanged so listeners have nothing to see.
    // Method-aware: list/get never reach this branch (the early
    // read-return above), so anything getting here is a write whose
    // path is the touched key.
    if (isAllowed) {
      // Issue #307 — set the trigger so listener re-eval emits can
      // attribute themselves to this user op via `triggeredBy`.
      // Save/restore (not clear-on-finally) because a listener callback
      // may itself call execute() — that nested call's finally would
      // otherwise wipe our trigger before subsequent listeners fire.
      const prevTrigger = this.currentTrigger;
      this.currentTrigger = { method, path };
      try {
        this.notifyListenersForPaths(new Set([path]));
      } finally {
        this.currentTrigger = prevTrigger;
      }
    }
    return out;
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
    const trimmed = collection.endsWith('/') ? collection.slice(0, -1) : collection;
    const id = generateAutoId();
    const path = `${trimmed}/${id}`;
    // Signal that this create came via auto-id minting so emitWrite
    // populates WriteSandboxEvent.autoId. The replay engine reads this
    // to know the path's last segment should alias to a fresh mint on
    // replay rather than reuse the original ID.
    const result = this.execute({ method: 'create', path, auth, data, autoId: true, bypassRules });
    return { path, result };
  }

  // ═══ Batch operations ═══

  /** Execute multiple writes atomically. All must pass rules or none apply. */
  batch(
    operations: BatchOperationInput[],
    auth: Operation['auth'],
    bypassRules?: boolean,
  ): BatchResult {
    const detail = bypassRules ? { admin: true } : undefined;
    // Capture priors for just the operations' paths (undo is O(affected)).
    const snapshot = this.capturePriors(operations.map((o) => o.path));
    const results: BatchResult['results'] = [];

    // Item 1: one serverTime for the whole batch — all sentinels and
    // every per-op `request.time` resolve to the same wall-clock instant.
    const serverTime = Timestamp.fromMillis(Date.now());
    // Issue #307 — shared groupId so the consumer can fold sub-ops into
    // a single batch row.
    const groupId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // Track per-op events to emit (one per resolved op). We build them
    // lazily and dispatch after applyBatch so resourceAfter reflects the
    // committed (or rolled-back) state, matching execute()'s ordering.
    const pendingEmits: EmitRequestInput[] = [];

    // Resolve every op's payload up front against CURRENT state (no
    // cross-visibility, mirroring how the rules pass evaluates them).
    // Item 0: write-boundary value-resolve. Item 2: sentinels in batch
    // ops resolve against the right prior; a converter throw rejects
    // the whole batch (atomic semantics).
    const resolvedOps: BatchOperationInput[] = [];
    for (const op of operations) {
      try {
        resolvedOps.push({
          ...op,
          data: op.data
            ? resolveValueTree({ ...op.data }, {
                path: op.path,
                method: op.method as ResolveMethod,
                prior: this.state.get(op.path),
                serverTime,
              })
            : op.data,
        });
      } catch (e) {
        const msg = (e as Error).message;
        const event = this.eventLog.append({
          type: 'batch', method: 'batch', path: '',
          auth: auth ? { uid: auth.uid } : null,
          allowed: false,
          operations: operations.map((o) => ({
            method: o.method, path: o.path, data: o.data, allowed: false,
          })),
          debugMessages: [`FieldValue resolve error on '${op.path}': ${msg}`],
        });
        // Issue #307 — emit the failing op (and only the failing op;
        // earlier ops in the loop succeeded and their events were
        // queued, later ops never reached evaluation).
        this.emitRequest({
          at: Date.now(), evalMs: 0,
          method: op.method, path: op.path, auth, result: 'deny',
          debugMessages: [`FieldValue resolve error: ${msg}`],
          ...(op.data ? { resourceData: op.data } : {}),
          resourceBefore: { data: snapshot[op.path] ?? null, exists: (snapshot[op.path] ?? null) !== null },
          origin: 'batch', groupId,
          ...(detail ? { detail } : {}),
        });
        // Item 6: same code as the single-op resolver throw —
        // invalid-argument is the admin-SDK signal for malformed
        // FieldValue. The whole batch rolls back atomically; only the
        // failing op gets the per-op error attached.
        const batchError = makeError('invalid-argument', msg);
        return {
          allowed: false,
          results: operations.map((o) => ({
            path: o.path,
            allowed: false,
            debugMessages: [msg],
            ...(o.path === op.path ? { error: batchError } : {}),
          })),
          event,
          error: batchError,
        };
      }
    }

    // Evaluate rules for each operation. `request`/`resource` (the doc's
    // OWN pre/post state) still resolve against CURRENT pre-batch state —
    // no cross-visibility there, matching how request.resource.data works
    // in production. `getAfter()` on a SIBLING doc is different: it must
    // see this batch's other pending writes, so we build one shared
    // post-commit projection up front (getafter-batch fix) and hand the
    // same map to every op's simulate() call below.
    const batchTestCases = resolvedOps.map((op) =>
      this.buildTestCase({ method: op.method, path: op.path, auth, data: op.data }, serverTime),
    );
    const batchProjection = this.buildBatchProjection(batchTestCases);

    let allAllowed = true;
    for (let i = 0; i < resolvedOps.length; i++) {
      const op = resolvedOps[i]!;
      // Pre-resolution payload from the original operations array (parallel
      // to resolvedOps by index). Emitted on RequestEvent/WriteSandboxEvent
      // so consumers see the user's INTENT (with FieldValue.* markers),
      // not the materialized values.
      const preData = operations[i]?.data;
      const testCase = batchTestCases[i]!;
      const evalAt = Date.now();
      const evalStart = performance.now();
      const simResult = this.runSimulate([testCase], bypassRules, batchProjection);
      const evalMs = performance.now() - evalStart;

      if (!simResult.success) {
        // Item 6: per-op simulator failure — same invalid-argument signal
        // as the single-op path uses.
        results.push({
          path: op.path,
          allowed: false,
          debugMessages: [simResult.error.message],
          error: makeError('invalid-argument', simResult.error.message),
        });
        pendingEmits.push({
          at: evalAt, evalMs, method: op.method, path: op.path, auth,
          result: 'deny',
          debugMessages: [`Simulation error: ${simResult.error.message}`],
          ...(preData ? { resourceData: preData } : {}),
          resourceBefore: { data: snapshot[op.path] ?? null, exists: (snapshot[op.path] ?? null) !== null },
          origin: 'batch', groupId,
          ...(detail ? { detail } : {}),
        });
        allAllowed = false;
        continue;
      }

      const r = simResult.data.results[0];
      if (r.state === 'UNSUPPORTED') {
        // Emit the unsupported event before throwing — same contract as execute().
        this.emitRequest({
          at: evalAt, evalMs, method: op.method, path: op.path, auth,
          result: 'unsupported', debugMessages: renderLegacyDebugMessages(r),
          ...(preData ? { resourceData: preData } : {}),
          resourceBefore: { data: snapshot[op.path] ?? null, exists: (snapshot[op.path] ?? null) !== null },
          origin: 'batch', groupId,
          ...(detail ? { detail } : {}),
        });
        throw new SimulatorUnsupportedError(
          unsupportedMessage(op.method, op.path, renderLegacyDebugMessages(r)),
          op.method, op.path, renderLegacyDebugMessages(r),
        );
      }
      const isAllowed = r.state === 'PASSED';
      const entry: BatchResult['results'][number] = {
        path: op.path,
        allowed: isAllowed,
        debugMessages: renderLegacyDebugMessages(r),
      };
      if (!isAllowed) {
        // Item 6: rule denied this op — permission-denied. Structural
        // errors are surfaced separately below if rules pass. The
        // per-op `request`/`resource` is captured against the pre-batch
        // snapshot since rules eval has no inter-write visibility
        // (matches `batch()` semantics).
        const priorDoc = snapshot[op.path] ?? null;
        entry.error = makeError(
          'permission-denied',
          `${op.method} ${op.path} denied by rules`,
          {
            request: {
              method: op.method,
              path: op.path,
              auth,
              ...(preData ? { resourceData: preData } : {}),
            },
            resource: { data: priorDoc, exists: priorDoc !== null },
          },
        );
        this.emitDenial(entry.error);
        allAllowed = false;
      }
      // Issue #307 — queue per-op event. resourceAfter is filled in
      // below once we know whether applyBatch committed (allAllowed) or
      // rolled back.
      pendingEmits.push({
        at: evalAt, evalMs, method: op.method, path: op.path, auth,
        result: isAllowed ? 'allow' : 'deny',
        debugMessages: renderLegacyDebugMessages(r),
        ...(preData ? { resourceData: preData } : {}),
        resourceBefore: { data: snapshot[op.path] ?? null, exists: (snapshot[op.path] ?? null) !== null },
        origin: 'batch', groupId,
        ...(detail ? { detail } : {}),
      });
      results.push(entry);
    }

    // Apply all or none
    let batchStructuralError: FirestoreSimError | null = null;
    if (allAllowed) {
      const batchOps: BatchOperation[] = resolvedOps.map(op => ({
        method: op.method as BatchOperation['method'],
        path: op.path,
        data: op.data,
      }));
      const batchResult = this.state.applyBatch(batchOps);
      if (!batchResult.success) {
        allAllowed = false;
        // Item 6: applyBatch returns indexed structural errors. Map the
        // first one and pin it to the offending per-op result. Mirrors
        // single-op precondition mapping (create→already-exists,
        // update/delete→not-found).
        const first = batchResult.errors?.[0];
        if (first !== undefined) {
          const failingOp = resolvedOps[first.index];
          const code = failingOp?.method === 'create' ? 'already-exists' : 'not-found';
          batchStructuralError = makeError(code, first.error);
          // Demote the per-op result for the offender — its rules said
          // PASSED but the keyspace overruled.
          const failingResult = results[first.index];
          if (failingResult) {
            failingResult.allowed = false;
            failingResult.error = batchStructuralError;
          }
        }
      }
    }

    const event = this.eventLog.append({
      type: 'batch', method: 'batch', path: '',
      auth: auth ? { uid: auth.uid } : null,
      allowed: allAllowed,
      priorDocs: allAllowed ? snapshot : undefined,
      operations: resolvedOps.map((op, i) => ({
        method: op.method, path: op.path, data: op.data,
        allowed: results[i]?.allowed ?? false,
      })),
      debugMessages: allAllowed ? ['Batch committed'] : ['Batch rolled back — one or more operations denied'],
    });

    // Item 6: top-level batch error — pick the first per-op error if
    // any, or a structural error if rules passed but applyBatch rejected.
    let topError: FirestoreSimError | undefined;
    if (!allAllowed) {
      topError =
        batchStructuralError ??
        results.find((r) => r.error)?.error ??
        makeError('permission-denied', 'Batch denied');
    }

    // Issue #307 — flush per-op events now that applyBatch has decided.
    // resourceAfter reflects the post-commit state on success; for
    // rollbacks (allAllowed false, or structural error demoting a
    // PASSED op) it mirrors the prior — no change happened. Delete
    // ops always end up exists:false on commit; on rollback they revert.
    for (let i = 0; i < pendingEmits.length; i++) {
      const e = pendingEmits[i];
      if (!e) continue;
      const opCommitted = allAllowed && results[i]?.allowed === true;
      if (opCommitted) {
        const finalDoc = this.state.get(e.path);
        if (e.method !== 'delete') {
          e.resourceAfter = { data: finalDoc, exists: finalDoc !== null };
        } else {
          e.resourceAfter = { data: null, exists: false };
        }
      } else {
        // rollback or structural-error demotion — state didn't change.
        const priorDoc = snapshot[e.path] ?? null;
        e.resourceAfter = { data: priorDoc, exists: priorDoc !== null };
      }
      this.emitRequest(e);
      // Issue #307 — committed-write event for sub-ops that actually
      // applied. Mirrors the per-sub-op groupId on the RequestEvent.
      if (opCommitted && e.method !== 'get' && e.method !== 'list') {
        const priorDoc = snapshot[e.path] ?? null;
        // Sentinels: walk the PRE-resolution data from `operations[i]`
        // (parallel to resolvedOps and pendingEmits — built in order
        // earlier in this method).
        const preOp = operations[i];
        const sentinels =
          preOp && 'data' in preOp && preOp.data ? walkForSentinels(preOp.data) : undefined;
        this.emitWrite({
          method: e.method as 'create' | 'update' | 'set' | 'delete',
          path: e.path,
          auth,
          ...(e.method !== 'delete' && e.resourceData ? { data: e.resourceData } : {}),
          priorState: priorDoc,
          nextState: e.method === 'delete' ? null : this.state.get(e.path),
          ...(e.groupId ? { groupId: e.groupId, groupKind: 'batch' as const } : {}),
          ...(sentinels && sentinels.length > 0 ? { sentinels } : {}),
          requestTime: serverTime,
          ...(detail ? { detail } : {}),
        });
      }
    }
    // Slice 3 — fan out batch writes to listeners. Single fire after
    // commit (matches the Slice 5 design — fire-once-per-batch is what
    // we want long-term; doing it here means Slice 5 only needs to
    // hoist the call point, not invent it). Skipped on rollback —
    // nothing in `state` actually changed.
    if (allAllowed) {
      const touched = new Set<string>();
      for (const op of resolvedOps) touched.add(op.path);
      // Issue #307 — listener re-evals during this fan-out attribute
      // themselves to the batch as a whole. Path is the first sub-op
      // (best-effort — batches touch N paths, the UI can join via groupId
      // if it needs to show the full set).
      const firstOp = resolvedOps[0];
      const prevTrigger = this.currentTrigger;
      this.currentTrigger = firstOp
        ? { method: 'batch', path: firstOp.path }
        : { method: 'batch', path: '' };
      try {
        this.notifyListenersForPaths(touched);
      } finally {
        this.currentTrigger = prevTrigger;
      }
    }
    return {
      allowed: allAllowed,
      results,
      event,
      ...(topError ? { error: topError } : {}),
    };
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
      const prevTrigger = this.currentTrigger;
      this.currentTrigger = firstOp
        ? { method: 'transaction', path: firstOp.path }
        : { method: 'transaction', path: '' };
      try {
        this.notifyListenersForPaths(touched);
      } finally {
        this.currentTrigger = prevTrigger;
      }
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
    const event = this.eventLog.popLastWrite();
    if (!event) return null;
    if (event.priorDocs) this.state.restorePaths(event.priorDocs);
    else if (event.snapshot) this.state.restore(event.snapshot);
    else return null;
    return event;
  }

  /** Redo the last undone operation. Re-applies the write directly
   *  without going through execute() (which would clear the redo stack). */
  redo(): OperationResult | null {
    const event = this.eventLog.popLastUndo();
    if (!event) return null;

    // Capture prior state BEFORE re-applying (for a future undo of this redo),
    // matching the kind the event used: affected paths for single-write / batch,
    // the whole keyspace for a transaction.
    const affectedPaths = (event.type === 'batch' && event.operations)
      ? event.operations.map((op) => op.path)
      : event.path ? [event.path] : [];
    const useFullSnapshot = !!event.snapshot;
    const priorDocs = useFullSnapshot ? undefined : this.capturePriors(affectedPaths);
    const snapshot = useFullSnapshot ? this.state.snapshot() : undefined;

    // Re-apply the write directly to state
    if (event.type === 'batch' && event.operations) {
      for (const op of event.operations) {
        if (op.allowed) this.applyWrite(op.method, op.path, op.data);
      }
    } else if (event.allowed) {
      this.applyWrite(event.method, event.path, event.data);
    }

    // Re-append with preserveRedo=true so remaining redos aren't lost
    const newEvent = this.eventLog.append({
      ...event,
      snapshot,
      priorDocs,
    }, true);

    return {
      allowed: event.allowed,
      debugMessages: ['Redo: ' + (event.allowed ? 'applied' : 'skipped (was denied)')],
      event: newEvent,
    };
  }

  // ═══ Event log access ═══

  /** Get all events. */
  getEvents(): AgentEvent[] {
    return this.eventLog.getEvents();
  }

  /** Get event count. */
  getEventCount(): number {
    return this.eventLog.size();
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
