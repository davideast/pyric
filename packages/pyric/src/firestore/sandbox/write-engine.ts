import { type BatchOperation, type DocStore, type DocumentData } from './local-state.js';
import {
  registerDefaultConverters,
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
  SimulatorUnsupportedError,
  unsupportedMessage,
} from './rules-evaluation.js';
import type {
  BatchOperationInput,
  BatchResult,
  Operation,
  OperationResult,
  WriteOperation,
} from './writes.js';
import { EventLog } from './event-log.js';
import { FirestoreEventBus } from './event-bus.js';
import { TriggerScope } from './trigger-scope.js';
import { assertNoNestedDeleteField } from './field-merge.js';
import { generateAutoId } from './auto-id.js';
import { walkForSentinels } from './sentinel-capture.js';
import { buildRequestEvent, nextRequestEventId, type EmitRequestInput } from './request-events.js';
import { TransactionContext, type TransactionReader } from './transaction.js';
import { mergeQueuedWrites } from './transaction-merge.js';
import type {
  Transaction,
  TransactionOptions,
  TransactionResult,
} from './transaction-types.js';
import { buildRulesTestCase } from './rules-test-case.js';

registerDefaultConverters();

interface WriteEngineHost {
  readonly state: DocStore;
  notifyListenersForPaths(paths: Set<string>): void;
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
    return this.simulator.simulate(this.rules.source, testCases, {
      getDoc: (path) => this.host.state.get(path),
      ...(batchProjection ? { batchProjection } : {}),
    });
  }

  private buildBatchProjection(testCases: TestCase[]): Map<string, DocumentData | null> {
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

  private buildTestCase(operation: Operation, serverTime?: Timestamp): TestCase {
    return buildRulesTestCase(this.host.state, operation, serverTime);
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
  execute(operation: WriteOperation): OperationResult {
    const { method, path, auth, data, autoId, requestTime: pinnedRequestTime, merge, bypassRules } = operation;
    const detail = bypassRules ? { admin: true } : undefined;

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
        this.host.notifyListenersForPaths(new Set([path])),
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
                prior: this.host.state.get(op.path),
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
      const batchResult = this.host.state.applyBatch(batchOps);
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
        const finalDoc = this.host.state.get(e.path);
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
          nextState: e.method === 'delete' ? null : this.host.state.get(e.path),
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
      this.triggerScope.run(
        { method: 'batch', path: firstOp?.path ?? '' },
        () => this.host.notifyListenersForPaths(touched),
      );
    }
    return {
      allowed: allAllowed,
      results,
      event,
      ...(topError ? { error: topError } : {}),
    };
  }
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
    const snapshot = this.host.state.snapshot();

    const reader: TransactionReader = (path) => this.host.state.get(path);
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
          prior: this.host.state.get(op.path),
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
          ? this.host.state.get(op.path) !== null
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
                ? this.host.state.get(o.path) !== null
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
      const exists = this.host.state.get(op.path) !== null;
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
      const exists = this.host.state.get(op.path) !== null;
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
      const applyResult = this.host.state.applyBatch(resolvedOps);
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
        const finalDoc = this.host.state.get(e.path);
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
          nextState: e.method === 'delete' ? null : this.host.state.get(e.path),
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
        () => this.host.notifyListenersForPaths(touched),
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

}
