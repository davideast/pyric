/**
 * RulesReadEngine — the rules-gated read machinery for the Firestore
 * sandbox engine (ADR-0009, PR B3).
 *
 * Owns user reads through {@link RulesOperationReader}, silent reads that
 * back snapshot listeners, and candidate gathering/execution for the
 * web-modular + admin-compat query surfaces. Shared list-rule authorization
 * lives in {@link RulesListAuthorizer}. This class implements
 * {@link ListenerDispatchHost} directly, replacing the facade closures
 * PR B2 injected into ListenerDispatch.
 *
 * Dependencies are the narrow slices these reads actually touch:
 *   - {@link RulesReadHost} — live DocStore access (`seed()` replaces the
 *     keyspace, so the getter must not capture a stale reference).
 *   - {@link RulesState} — deployed source + RULES-B11 parsed-AST cache
 *     for the query-proof gate.
 *   - the simulator, {@link TriggerScope} (listener-origin RequestEvents
 *     carry `triggeredBy`), and {@link FirestoreEventBus}; document-read
 *     payloads stay here while list-read payloads live in the authorizer.
 */
import type { DocStore, DocumentData } from './local-state.js';
import type {
  SimulateFirestoreRulesHandler,
} from 'pyric/rules/internal';
import { renderLegacyDebugMessages, projectEvaluatedRule, Timestamp } from 'pyric/rules/internal';
import { makeError, type FirestoreSimError } from './errors.js';
import type { OperationResult, ReadOperation } from './writes.js';
import type { ListenerAuth, QueryConstraintInput } from './snapshot-listeners.js';
import type { ListenerDispatchHost } from './listener-dispatch.js';
import { buildRequestEvent, type EmitRequestInput } from './request-events.js';
import type { FirestoreEventBus } from './event-bus.js';
import type { TriggerScope } from './trigger-scope.js';
import type { RulesState } from './rules-state.js';
import {
  SimulatorUnsupportedError,
  unsupportedMessage,
} from './rules-evaluation.js';
import { buildRulesTestCase } from './rules-test-case.js';
import { EventLog } from './event-log.js';
import { RulesOperationReader } from './rules-operation-reader.js';
import { RulesListAuthorizer } from './rules-list-authorizer.js';
import {
  executeQuery,
  gatherQueryRows,
  captureQueryExecutionSpec,
  captureQueryScope,
  queryConstraintsForProof,
  type RunQueryRequest,
  type RunQueryResult,
} from './query-execution.js';

/**
 * The engine capability read paths need from the facade. `state` is a live
 * getter because `seed()` swaps the whole keyspace object.
 */
export interface RulesReadHost {
  readonly state: DocStore;
}

export class RulesReadEngine implements ListenerDispatchHost {
  private readonly operationReader: RulesOperationReader;
  private readonly listAuthorizer: RulesListAuthorizer;

  constructor(
    private readonly events: FirestoreEventBus,
    private readonly triggerScope: TriggerScope,
    private readonly rules: RulesState,
    private readonly simulator: SimulateFirestoreRulesHandler,
    private readonly host: RulesReadHost,
    eventLog: EventLog,
  ) {
    this.operationReader = new RulesOperationReader(
      events,
      rules,
      simulator,
      host,
      eventLog,
    );
    this.listAuthorizer = new RulesListAuthorizer(events, rules, simulator, host);
  }

  private get state(): DocStore {
    return this.host.state;
  }

  /** Same lazy-allocation contract as the facade's emitRequest. */
  private emitRequest(input: EmitRequestInput): void {
    if (!this.events.request.hasSubscribers) return;
    this.events.request.emit(buildRequestEvent(input));
  }

  execute(operation: ReadOperation): OperationResult {
    return this.operationReader.execute(operation);
  }
  /**
   * Run a `get` through the rules without touching the event log.
   * Returns the read shape used by listener-snapshot construction.
   *
   * Throws `SimulatorUnsupportedError` on UNSUPPORTED — same loud
   * surface as `execute`; the caller is then responsible for
   * propagating it. Listener-init paths catch nothing: an unsupported
   * rule is a sandbox limitation worth surfacing to the agent
   * verbatim, not silently rerouting through `errorCallback`.
   */
  silentReadDoc(
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
        origin: 'listener',
        resourceBefore: { data, exists: data !== null },
        detail: { admin: true },
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
      });
      return { allowed: true, data };
    }
    const readServerTime = Timestamp.fromMillis(Date.now());
    const testCase = buildRulesTestCase(this.state, { method: 'get', path, auth }, readServerTime);
    // Issue #307 — time the simulate call for listener-origin RequestEvents.
    const evalAt = Date.now();
    const evalStart = performance.now();
    const simResult = this.simulator.simulate(this.rules.source, [testCase], {
      getDoc: (path) => this.state.get(path),
    });
    const evalMs = performance.now() - evalStart;
    if (!simResult.success) {
      this.emitRequest({
        at: evalAt, evalMs, method: 'get', path, auth, result: 'deny',
        debugMessages: [`Simulation error: ${simResult.error.message}`],
        origin: 'listener',
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
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
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
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
      ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
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
   *      constraints derived from the captured execution plan.
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
  silentReadCollection(
    collection: string,
    auth: ListenerAuth,
    constraints?: QueryConstraintInput,
    bypassRules = false,
  ): { allowed: true; docs: { path: string; data: DocumentData }[] } | { allowed: false; error: FirestoreSimError } {
    if (typeof constraints === 'function') {
      return {
        allowed: false,
        error: makeError(
          'invalid-argument',
          'Callable query constraints are no longer executable; pass an immutable QueryConstraintPlan.',
        ),
      };
    }
    const execution = constraints
      ? captureQueryExecutionSpec(constraints.execution)
      : undefined;
    const structured = execution
      ? queryConstraintsForProof(execution)
      : {};
    const timing = {
      requestTime: Timestamp.fromMillis(Date.now()),
      at: Date.now(),
    };
    const triggeredBy = this.triggerScope.current();
    if (bypassRules) {
      const docs = this.state.list(collection)
        .filter((document) => !document.phantom)
        .map((document) => ({ path: document.path, data: document.data }));
      const constrained = execution ? executeQuery(docs, execution) : docs;
      const authorization = this.listAuthorizer.authorize({
        path: collection,
        auth,
        constraints: structured,
        bypassRules,
        ...(constraints?.activityQuery ? { activityQuery: constraints.activityQuery } : {}),
        origin: 'listener',
        ...(triggeredBy ? { triggeredBy } : {}),
        timing,
      });
      if (!authorization.allowed) return authorization;
      return { allowed: true, docs: constrained };
    }
    const authorization = this.listAuthorizer.authorize({
      path: collection,
      auth,
      constraints: structured,
      ...(constraints?.activityQuery ? { activityQuery: constraints.activityQuery } : {}),
      origin: 'listener',
      ...(triggeredBy ? { triggeredBy } : {}),
      timing,
    });
    if (!authorization.allowed) return authorization;
    const docs = this.state.list(collection)
      .filter((document) => !document.phantom)
      .map((document) => ({ path: document.path, data: document.data }));
    const constrained = execution ? executeQuery(docs, execution) : docs;
    return { allowed: true, docs: constrained };
  }

  /**
   * Rule-enforced collection read — the query (`getDocs` / `Query.get` /
   * aggregate) read path for the web-modular + auth-scoped admin-compat
   * surfaces. **Unlike `listDocuments` this evaluates security
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
   * The request is an immutable plan. This engine gathers collection or
   * collection-group candidates, proves the list rule, and executes the
   * filters/order/cursors/limit without exposing raw rows to the adapter.
   * Rules-enforced collection-group reads use only universal recursive rules;
   * group-specific recursive-suffix shapes fail closed until symbolic proof is
   * supported. bypassRules remains available to the explicit admin lens.
   *
   * Emits `origin: 'user'` request events (one per `list`) so inspector
   * consumers see query reads the same way they see writes. UNSUPPORTED
   * rules still bubble as {@link SimulatorUnsupportedError}.
   */
  runQuery(request: RunQueryRequest): RunQueryResult {
    const scope = captureQueryScope(request.scope);
    const execution = captureQueryExecutionSpec(request.execution);
    const auth = request.auth;
    const bypassRules = request.bypassRules;
    const activityQuery = request.activityQuery;
    const candidates = gatherQueryRows(this.state, scope);
    const listPath = scope.kind === 'collection' ? scope.path : scope.collectionId;
    const proof = queryConstraintsForProof(execution);
    const authorization = this.listAuthorizer.authorize({
      path: listPath,
      collectionGroup: scope.kind === 'collection-group',
      auth,
      constraints: proof,
      bypassRules,
      ...(activityQuery !== undefined ? { activityQuery } : {}),
      origin: 'user',
    });
    if (!authorization.allowed) return authorization;
    return { allowed: true, docs: executeQuery(candidates, execution) };
  }
}
