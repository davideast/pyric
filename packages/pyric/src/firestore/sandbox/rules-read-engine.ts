/**
 * RulesReadEngine — the rules-gated read machinery for the Firestore
 * sandbox engine (ADR-0009, PR B3).
 *
 * Owns user reads through {@link RulesOperationReader}, silent reads that
 * back snapshot listeners, and the query-read enforcement path used by the
 * web-modular + admin-compat query surfaces. It implements
 * {@link ListenerDispatchHost} directly, replacing the facade closures
 * PR B2 injected into ListenerDispatch.
 *
 * Dependencies are the narrow slices these reads actually touch:
 *   - {@link RulesReadHost} — live DocStore access (`seed()` replaces the
 *     keyspace, so the getter must not capture a stale reference).
 *   - {@link RulesState} — deployed source + RULES-B11 parsed-AST cache
 *     for the query-proof gate.
 *   - the simulator, {@link TriggerScope} (listener-origin RequestEvents
 *     carry `triggeredBy`), and {@link FirestoreEventBus} (request +
 *     denial channels; payload building stays here for lazy allocation).
 */
import type { DocStore, DocumentData } from './local-state.js';
import type {
  SimulateFirestoreRulesHandler,
  TestCase,
} from 'pyric/rules/internal';
import { renderLegacyDebugMessages, projectEvaluatedRule, Timestamp } from 'pyric/rules/internal';
// RULES-B11 — query-proof gate for list reads ("rules are not filters").
import { proveListQuery, renderQueryRemediation, type QueryConstraints } from './list-query-proof.js';
import { makeError, type FirestoreSimError } from './errors.js';
import type { Operation, OperationResult, ReadOperation } from './writes.js';
import type { ListenerAuth, QueryConstraintInput } from './snapshot-listeners.js';
import type { ListenerDispatchHost } from './listener-dispatch.js';
import { buildRequestEvent, type EmitRequestInput } from './request-events.js';
import { listQueryFromStructured } from './reads.js';
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
import {
  executeQuery,
  gatherQueryRows,
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
  }

  private get state(): DocStore {
    return this.host.state;
  }

  /** Same lazy-allocation contract as the facade's emitRequest. */
  private emitRequest(input: EmitRequestInput): void {
    if (!this.events.request.hasSubscribers) return;
    this.events.request.emit(buildRequestEvent(input));
  }

  private emitDenial(err: FirestoreSimError): void {
    this.events.denial.emit(err);
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
    const execution = constraints?.execution;
    const readServerTime = Timestamp.fromMillis(Date.now());
    // List rules are defined at the document-match level, so the
    // simulator expects a document-style path with a synthetic
    // placeholder segment (matches the convention used by
    // local-env-reads tests). Without it, a `list` against a bare
    // collection path falls through to no match and is denied.
    const listPath = `${collection}/__listPlaceholder__`;
    const structured: QueryConstraints = execution
      ? queryConstraintsForProof(execution)
      : {};
    const requestQuery = listQueryFromStructured(structured);
    const detailFields = {
      ...(bypassRules ? { admin: true } : {}),
      ...(requestQuery ? { query: requestQuery } : {}),
      ...(constraints?.activityQuery ? { activityQuery: constraints.activityQuery } : {}),
    };
    const requestDetail = Object.keys(detailFields).length > 0 ? detailFields : undefined;
    const evalAt = Date.now();
    const evalStart = performance.now();
    if (bypassRules) {
      const docs = this.state.list(collection)
        .filter((document) => !document.phantom)
        .map((document) => ({ path: document.path, data: document.data }));
      const constrained = execution ? executeQuery(docs, execution) : docs;
      this.emitRequest({
        at: evalAt,
        evalMs: 0,
        method: 'list',
        path: collection,
        auth,
        result: 'allow',
        debugMessages: ['admin lens — rules bypassed'],
        origin: 'listener',
        ...(requestDetail ? { detail: requestDetail } : {}),
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
      });
      return { allowed: true, docs: constrained };
    }
    // ── RULES-B11 gate: prove the query before evaluating the rule. ──
    const proof = proveListQuery(this.rules.ast(), listPath, auth, structured);
    if (proof.kind === 'unprovable') {
      const evalMs = performance.now() - evalStart;
      const message =
        `list ${collection} denied: the query is statically unprovable for every possible ` +
        `result (rules are not filters), so the whole query is rejected — ${proof.reason}`;
      const remediation = renderQueryRemediation(proof.residual);
      this.emitRequest({
        at: evalAt, evalMs, method: 'list', path: collection, auth, result: 'deny',
        debugMessages: [message], origin: 'listener',
        ...(requestDetail ? { detail: requestDetail } : {}),
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
      });
      return {
        allowed: false,
        error: makeError('permission-denied', message, {
          request: { method: 'list', path: collection, auth },
          query: structured,
          ...(remediation ? { remediation } : {}),
        }),
      };
    }
    const testCase = buildRulesTestCase(
      this.state,
      { method: 'list', path: listPath, auth },
      readServerTime,
    );
    this.applyListProof(testCase, proof, structured);
    // Issue #307 — time the outer list eval.
    const simResult = this.simulator.simulate(this.rules.source, [testCase], {
      getDoc: (path) => this.state.get(path),
    });
    const evalMs = performance.now() - evalStart;
    if (!simResult.success) {
      this.emitRequest({
        at: evalAt, evalMs, method: 'list', path: collection, auth, result: 'deny',
        debugMessages: [`Simulation error: ${simResult.error.message}`],
        origin: 'listener',
        ...(requestDetail ? { detail: requestDetail } : {}),
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
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
        ...(requestDetail ? { detail: requestDetail } : {}),
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
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
        ...(requestDetail ? { detail: requestDetail } : {}),
        ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
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
      ...(requestDetail ? { detail: requestDetail } : {}),
      ...(this.triggerScope.current() ? { triggeredBy: this.triggerScope.current() } : {}),
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
    const constrained = execution ? executeQuery(docs, execution) : docs;
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
   *
   * Emits `origin: 'user'` request events (one per `list`) so inspector
   * consumers see query reads the same way they see writes. UNSUPPORTED
   * rules still bubble as {@link SimulatorUnsupportedError}.
   */
  runQuery(request: RunQueryRequest): RunQueryResult {
    const execution = request.execution;
    const candidates = gatherQueryRows(this.state, request.scope);
    const proof = queryConstraintsForProof(execution);
    const read = this.readQueryCandidates(
      candidates,
      request.listPath,
      request.auth,
      proof,
      request.bypassRules,
      request.activityQuery,
    );
    if (!read.allowed) return read;
    return { allowed: true, docs: executeQuery(read.docs, execution) };
  }

  private readQueryCandidates(
    candidates: { path: string; data: DocumentData }[],
    listPath: string,
    auth: Operation['auth'],
    query?: QueryConstraints,
    bypassRules?: boolean,
    activityQuery?: unknown,
  ): { allowed: true; docs: { path: string; data: DocumentData }[] } | { allowed: false; error: FirestoreSimError } {
    const structured: QueryConstraints = query ?? {};
    const requestQuery = listQueryFromStructured(structured);
    const requestDetail = {
      ...(bypassRules ? { admin: true } : {}),
      ...(requestQuery ? { query: requestQuery } : {}),
      ...(activityQuery !== undefined ? { activityQuery } : {}),
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
    const proof = proveListQuery(this.rules.ast(), placeholderPath, auth, structured);
    if (proof.kind === 'unprovable') {
      const evalMs = performance.now() - evalStart;
      const message =
        `list ${listPath} denied: the query is statically unprovable for every possible ` +
        `result (rules are not filters), so the whole query is rejected — ${proof.reason}`;
      const remediation = renderQueryRemediation(proof.residual);
      this.emitRequest({
        at: evalAt, evalMs, method: 'list', path: listPath, auth, result: 'deny',
        debugMessages: [message], origin: 'user',
        ...(detail ? { detail } : {}),
      });
      const error = makeError('permission-denied', message, {
        request: { method: 'list', path: listPath, auth },
        query: structured,
        ...(remediation ? { remediation } : {}),
      });
      this.emitDenial(error);
      return { allowed: false, error };
    }
    const testCase = buildRulesTestCase(
      this.state,
      { method: 'list', path: placeholderPath, auth },
      readServerTime,
    );
    this.applyListProof(testCase, proof, structured);
    const simResult = this.simulator.simulate(this.rules.source, [testCase], {
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
}
