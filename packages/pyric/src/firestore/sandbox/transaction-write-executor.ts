import type { BatchOperation, DocumentData } from './local-state.js';
import { resolveValueTree, type ResolveMethod } from './value-resolver.js';
import { makeError, type FirestoreSimError } from './errors.js';
import { renderLegacyDebugMessages, Timestamp } from 'pyric/rules/internal';
import {
  SimulatorUnsupportedError,
  unsupportedMessage,
} from './rules-evaluation.js';
import { walkForSentinels } from './sentinel-capture.js';
import type { EmitRequestInput } from './request-events.js';
import { TransactionContext, type TransactionReader } from './transaction.js';
import { mergeQueuedWrites } from './transaction-merge.js';
import type {
  Transaction,
  TransactionOptions,
  TransactionResult,
} from './transaction-types.js';
import { AtomicWriteRuntime } from './atomic-write-runtime.js';

/** Runs transaction callbacks and commits their queued writes atomically. */
export class TransactionWriteExecutor {
  constructor(private readonly runtime: AtomicWriteRuntime) {}

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
    const snapshot = this.runtime.state.snapshot();

    const reader: TransactionReader = (path) => this.runtime.state.get(path);
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
      const event = this.runtime.eventLog.append({
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
      this.runtime.eventLog.append({
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
          prior: this.runtime.state.get(op.path),
          serverTime,
        });
        resolvedOps.push({ ...op, data: resolved });
      } catch (e) {
        const msg = (e as Error).message;
        const wrapped = makeError('invalid-argument', msg);
        const event = this.runtime.eventLog.append({
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
          ? this.runtime.state.get(op.path) !== null
            ? 'update'
            : 'create'
          : op.method) as 'create' | 'update' | 'delete';
        const priorDoc = snapshot[op.path] ?? null;
        this.runtime.emitRequest({
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
                ? this.runtime.state.get(o.path) !== null
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
      const exists = this.runtime.state.get(op.path) !== null;
      const ruleMethod = (op.method === 'set'
        ? exists
          ? 'update'
          : 'create'
        : op.method) as 'create' | 'update' | 'delete';
      return this.runtime.buildTestCase({ method: ruleMethod, path: op.path, auth, data: op.data }, serverTime);
    });
    const txProjection = this.runtime.buildBatchProjection(txTestCases);

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
      const exists = this.runtime.state.get(op.path) !== null;
      const ruleMethod = (op.method === 'set'
        ? exists
          ? 'update'
          : 'create'
        : op.method) as 'create' | 'update' | 'delete';
      const priorDoc = snapshot[op.path] ?? null;

      const testCase = txTestCases[i]!;
      const evalAt = Date.now();
      const evalStart = performance.now();
      const sim = this.runtime.runSimulate([testCase], options.bypassRules, txProjection);
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
        this.runtime.emitRequest({
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
        this.runtime.emitDenial(entry.error);
        allAllowed = false;
      }
      writeResults.push(entry);
    }

    // ─── Step 6 — atomic apply (only if all rules passed) ────────────
    let structuralError: FirestoreSimError | null = null;
    if (allAllowed) {
      const applyResult = this.runtime.state.applyBatch(resolvedOps);
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
    const event = this.runtime.eventLog.append({
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
        const finalDoc = this.runtime.state.get(e.path);
        if (e.method !== 'delete') {
          e.resourceAfter = { data: finalDoc, exists: finalDoc !== null };
        } else {
          e.resourceAfter = { data: null, exists: false };
        }
      } else {
        const priorDoc = snapshot[e.path] ?? null;
        e.resourceAfter = { data: priorDoc, exists: priorDoc !== null };
      }
      this.runtime.emitRequest(e);
      if (opCommitted && e.method !== 'get' && e.method !== 'list') {
        const priorDoc = snapshot[e.path] ?? null;
        // Sentinels: walk the PRE-resolution data from `mergedOps[i]`
        // (parallel to resolvedOps and pendingEmits).
        const preOp = mergedOps[i];
        const sentinels =
          preOp && preOp.method !== 'delete' && preOp.data
            ? walkForSentinels(preOp.data)
            : undefined;
        this.runtime.emitWrite({
          method: e.method as 'create' | 'update' | 'set' | 'delete',
          path: e.path,
          auth,
          ...(e.method !== 'delete' && e.resourceData ? { data: e.resourceData } : {}),
          priorState: priorDoc,
          nextState: e.method === 'delete' ? null : this.runtime.state.get(e.path),
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
      this.runtime.notify('transaction', firstOp?.path ?? '', touched);
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
    this.runtime.eventLog.append({
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

