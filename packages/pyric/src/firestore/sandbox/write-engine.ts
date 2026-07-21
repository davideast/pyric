import { type DocStore, type DocumentData } from './local-state.js';
import {
  partitionDeletes,
  resolveValueTree,
  type ResolveMethod,
} from './value-resolver.js';
import { makeError, type FirestoreSimError } from './errors.js';
import type { TestCase, TestFirestoreRulesResult } from 'pyric/rules/internal';
import {
  projectEvaluatedRule,
  renderLegacyDebugMessages,
  SimulateFirestoreRulesHandler,
  Timestamp,
} from 'pyric/rules/internal';
import { RulesState } from './rules-state.js';
import {
  adminBypassResult,
  isoFromTimestamp,
  SimulatorUnsupportedError,
  unsupportedMessage,
} from './rules-evaluation.js';
import type { Operation, OperationResult } from './writes.js';
import { EventLog } from './event-log.js';
import { FirestoreEventBus } from './event-bus.js';
import { TriggerScope } from './trigger-scope.js';
import { ListenerDispatch } from './listener-dispatch.js';
import { assertNoNestedDeleteField } from './field-merge.js';
import { generateAutoId } from './auto-id.js';
import { walkForSentinels } from './sentinel-capture.js';
import { buildRequestEvent, nextRequestEventId, type EmitRequestInput } from './request-events.js';

export interface WriteEngineHost {
  readonly state: DocStore;
}

/** Rules-aware Firestore write policy behind the stable LocalEnvironment facade. */
export class WriteEngine {
  constructor(
    private readonly host: WriteEngineHost,
    private readonly rules: RulesState,
    private readonly simulator: SimulateFirestoreRulesHandler,
    private readonly eventLog: EventLog,
    private readonly events: FirestoreEventBus,
    private readonly triggerScope: TriggerScope,
    private readonly listeners: ListenerDispatch,
  ) {}

  private emitDenial(error: FirestoreSimError): void {
    this.events.denial.emit(error);
  }

  private emitRequest(input: EmitRequestInput): void {
    if (!this.events.request.hasSubscribers) return;
    this.events.request.emit(buildRequestEvent(input));
  }

  private emitWrite(input: {
    method: 'create' | 'update' | 'set' | 'delete';
    path: string;
    auth: Operation['auth'];
    data?: Record<string, unknown>;
    priorState: Record<string, unknown> | null;
    nextState: Record<string, unknown> | null;
    groupId?: string;
    groupKind?: 'batch' | 'transaction';
    sentinels?: import('./sentinel-capture.js').SentinelHit[];
    autoId?: string;
    requestTime: Timestamp;
    detail?: { admin?: boolean } & Record<string, unknown>;
    provenance?: import('../../sandbox/types/events.js').EventProvenance;
  }): void {
    if (!this.events.write.hasSubscribers) return;
    this.events.write.emit({
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
    });
  }

  capturePriors(paths: readonly string[]): Record<string, DocumentData | null> {
    const priors: Record<string, DocumentData | null> = {};
    for (const path of paths) {
      const prior = this.host.state.get(path);
      priors[path] = prior ? { ...prior } : null;
    }
    return priors;
  }

  runSimulate(
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
    return this.simulator.simulate(this.rules.source, testCases, {
      getDoc: (path) => this.host.state.get(path),
      ...(batchProjection ? { batchProjection } : {}),
    });
  }

  buildBatchProjection(testCases: TestCase[]): Map<string, DocumentData | null> {
    const projection = new Map<string, DocumentData | null>();
    for (const testCase of testCases) {
      if (testCase.method === 'get' || testCase.method === 'list') continue;
      projection.set(
        testCase.path,
        testCase.method === 'delete' ? null : (testCase.data ?? {}),
      );
    }
    return projection;
  }

  buildTestCase(operation: Operation, serverTime?: Timestamp): TestCase {
    const existingDoc = this.host.state.get(operation.path);
    const ruleMethod: TestCase['method'] = operation.method === 'set'
      ? (existingDoc !== null ? 'update' : 'create')
      : (operation.method as TestCase['method']);

    let requestData = operation.data;
    if (operation.method === 'get' || operation.method === 'list') {
      requestData = undefined;
    } else if (operation.method === 'update' && existingDoc && operation.data) {
      const { writes, deletedKeys } = partitionDeletes(operation.data);
      const merged: DocumentData = { ...existingDoc, ...writes };
      for (const key of deletedKeys) delete merged[key];
      requestData = merged;
    } else if (operation.data) {
      requestData = partitionDeletes(operation.data).writes;
    }

    return {
      description: `${operation.method} ${operation.path}`,
      expectation: 'ALLOW',
      method: ruleMethod,
      path: operation.path,
      auth: operation.auth ? { uid: operation.auth.uid, token: operation.auth.token } : null,
      data: requestData,
      resource: existingDoc ?? undefined,
      ...(serverTime ? { requestTime: isoFromTimestamp(serverTime) } : {}),
    };
  }

  applyWrite(
    method: string,
    path: string,
    data?: DocumentData,
    merge?: boolean | { mergeFields: readonly string[] },
  ): FirestoreSimError | null {
    if (merge !== undefined && merge !== false && (method === 'create' || method === 'update')) {
      const mergeFields = merge === true ? undefined : merge.mergeFields;
      this.host.state.setMerge(path, data ?? {}, mergeFields);
      return null;
    }
    switch (method) {
      case 'create': {
        const result = this.host.state.create(path, data ?? {});
        if (!result.success) {
          return makeError('already-exists', result.error ?? `Document '${path}' already exists`);
        }
        return null;
      }
      case 'update': {
        const result = this.host.state.update(path, data ?? {});
        if (!result.success) {
          return makeError('not-found', result.error ?? `Document '${path}' does not exist`);
        }
        return null;
      }
      case 'set':
        this.host.state.set(path, data ?? {});
        return null;
      case 'delete':
        this.host.state.delete(path);
        return null;
      default:
        return null;
    }
  }
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
        readData = method === 'get' ? this.host.state.get(path) : this.host.state.list(path) as unknown as DocumentData;
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
          ? { data: this.host.state.get(path), exists: this.host.state.get(path) !== null }
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
          ? { resourceBefore: { data: this.host.state.get(path), exists: this.host.state.get(path) !== null } }
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
            prior: this.host.state.get(path),
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
    const finalDoc = isAllowed ? this.host.state.get(path) : priorDoc;
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
      // TriggerScope.run saves/restores (not clear-on-finally) because a
      // listener callback may itself call execute() — that nested call
      // would otherwise wipe our trigger before subsequent listeners fire.
      this.triggerScope.run({ method, path }, () =>
        this.listeners.notifyListenersForPaths(new Set([path])),
      );
    }
    return out;
  }
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

}
