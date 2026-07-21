import type { BatchOperation, DocumentData } from './local-state.js';
import { resolveValueTree, type ResolveMethod } from './value-resolver.js';
import { makeError, type FirestoreSimError } from './errors.js';
import { renderLegacyDebugMessages, Timestamp } from 'pyric/rules/internal';
import {
  SimulatorUnsupportedError,
  unsupportedMessage,
} from './rules-evaluation.js';
import type {
  BatchOperationInput,
  BatchResult,
  Operation,
} from './writes.js';
import { walkForSentinels } from './sentinel-capture.js';
import type { EmitRequestInput } from './request-events.js';
import { AtomicWriteRuntime } from './atomic-write-runtime.js';

/** Executes one atomic batch using the shared atomic-write runtime policy. */
export class BatchWriteExecutor {
  constructor(private readonly runtime: AtomicWriteRuntime) {}

  batch(
    operations: BatchOperationInput[],
    auth: Operation['auth'],
    bypassRules?: boolean,
  ): BatchResult {
    const detail = bypassRules ? { admin: true } : undefined;
    // Capture priors for just the operations' paths (undo is O(affected)).
    const snapshot = this.runtime.capturePriors(operations.map((o) => o.path));
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
                prior: this.runtime.state.get(op.path),
                serverTime,
              })
            : op.data,
        });
      } catch (e) {
        const msg = (e as Error).message;
        const event = this.runtime.eventLog.append({
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
        this.runtime.emitRequest({
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
      this.runtime.buildTestCase({ method: op.method, path: op.path, auth, data: op.data }, serverTime),
    );
    const batchProjection = this.runtime.buildBatchProjection(batchTestCases);

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
      const simResult = this.runtime.runSimulate([testCase], bypassRules, batchProjection);
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
        this.runtime.emitRequest({
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
        this.runtime.emitDenial(entry.error);
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
      const batchResult = this.runtime.state.applyBatch(batchOps);
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

    const event = this.runtime.eventLog.append({
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
        const finalDoc = this.runtime.state.get(e.path);
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
      this.runtime.emitRequest(e);
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
        this.runtime.emitWrite({
          method: e.method as 'create' | 'update' | 'set' | 'delete',
          path: e.path,
          auth,
          ...(e.method !== 'delete' && e.resourceData ? { data: e.resourceData } : {}),
          priorState: priorDoc,
          nextState: e.method === 'delete' ? null : this.runtime.state.get(e.path),
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
      this.runtime.notify('batch', firstOp?.path ?? '', touched);
    }
    return {
      allowed: allAllowed,
      results,
      event,
      ...(topError ? { error: topError } : {}),
    };
  }
}

