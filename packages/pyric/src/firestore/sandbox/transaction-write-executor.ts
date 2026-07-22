import type { BatchOperation, DocumentData } from './local-state.js';
import { makeError, type FirestoreSimError } from './errors.js';
import {
  RetryableTransactionConflictError,
  TransactionAttemptsExhaustedError,
  TransactionContext,
  type TransactionReader,
} from './transaction.js';
import { mergeQueuedWrites } from './transaction-merge.js';
import type {
  Transaction,
  TransactionOptions,
  TransactionResult,
} from './transaction-types.js';
import { AtomicWritePipeline } from './atomic-write-pipeline.js';
import { WriteRuntime } from './write-runtime.js';

/** Adapts transaction callbacks, merge semantics, and results to the atomic pipeline. */
export class TransactionWriteExecutor {
  private readonly pipeline: AtomicWritePipeline;

  constructor(private readonly runtime: WriteRuntime) {
    this.pipeline = new AtomicWritePipeline(runtime);
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
    return this.runAttempt(fn, options, 1);
  }

  private runAttempt<R>(
    fn: (tx: Transaction) => R | Promise<R>,
    options: TransactionOptions,
    attempt: number,
  ): TransactionResult<R> | Promise<TransactionResult<R>> {
    const snapshot = this.runtime.state.snapshot();
    const attemptVersion = this.runtime.state.currentVersion();
    const versionsAtStart = new Map(
      Object.keys(snapshot).map((path) => [path, this.runtime.state.version(path)]),
    );
    const reader: TransactionReader = (path) => snapshot[path] ?? null;
    const context = new TransactionContext(reader, (path) => {
      const captured = versionsAtStart.get(path);
      if (captured !== undefined) return captured;
      const current = this.runtime.state.version(path);
      return current <= attemptVersion ? current : -1;
    });

    let callbackResult: R | Promise<R>;
    try {
      callbackResult = fn(context);
    } catch (error) {
      this.logAbortedTransaction(context, options.auth, error as Error);
      throw error;
    }

    if (
      callbackResult !== null &&
      typeof (callbackResult as PromiseLike<R>)?.then === 'function'
    ) {
      return (callbackResult as Promise<R>).then(
        (value) => {
          try {
            return this.commitTransaction(context, snapshot, options, value);
          } catch (error) {
            return this.retryOrThrow(error, fn, options, attempt);
          }
        },
        (error) => {
          this.logAbortedTransaction(context, options.auth, error as Error);
          throw error;
        },
      );
    }
    try {
      return this.commitTransaction(context, snapshot, options, callbackResult as R);
    } catch (error) {
      return this.retryOrThrow(error, fn, options, attempt);
    }
  }

  private retryOrThrow<R>(
    error: unknown,
    fn: (tx: Transaction) => R | Promise<R>,
    options: TransactionOptions,
    attempt: number,
  ): TransactionResult<R> | Promise<TransactionResult<R>> {
    if (!(error instanceof RetryableTransactionConflictError)) throw error;
    const maxAttempts = options.maxAttempts ?? 5;
    if (attempt >= maxAttempts) throw new TransactionAttemptsExhaustedError();
    return this.runAttempt(fn, options, attempt + 1);
  }

  private commitTransaction<R>(
    context: TransactionContext,
    snapshot: Record<string, DocumentData>,
    options: TransactionOptions,
    returnValue: R,
  ): TransactionResult<R> {
    const { reads, writes, readVersions } = context.consume();
    for (const [path, version] of readVersions) {
      if (this.runtime.state.version(path) !== version) {
        throw new RetryableTransactionConflictError();
      }
    }
    const auth = options.auth;
    if (writes.length === 0) {
      const event = this.runtime.eventLog.append({
        type: 'transaction',
        method: 'transaction',
        path: '',
        auth: auth ? { uid: auth.uid } : null,
        allowed: true,
        reads: reads.map((read) => ({ path: read.path, data: read.data })),
        operations: [],
        snapshot,
        debugMessages: ['Transaction committed (read-only — no writes queued)'],
      });
      return { allowed: true, reads: [...reads], writes: [], returnValue, event };
    }

    let mergedOps: BatchOperation[];
    try {
      mergedOps = mergeQueuedWrites(writes);
    } catch (error) {
      const err = error as Error;
      this.runtime.eventLog.append({
        type: 'transaction',
        method: 'transaction',
        path: '',
        auth: auth ? { uid: auth.uid } : null,
        allowed: false,
        aborted: true,
        reads: reads.map((read) => ({ path: read.path, data: read.data })),
        error: { name: err.name, message: err.message, code: 'failed-precondition' },
        debugMessages: [`Transaction aborted at merge: ${err.message}`],
      });
      throw error;
    }

    const priorDocs = Object.fromEntries(
      mergedOps.map((operation) => [operation.path, snapshot[operation.path] ?? null]),
    );
    const inputs = mergedOps.map((operation) => {
      const ruleMethod = operation.method === 'set'
        ? this.runtime.state.get(operation.path) !== null
          ? 'update'
          : 'create'
        : operation.method;
      return {
        ...operation,
        ruleMethod,
        preData: operation.data,
      };
    });
    const txId = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const prepared = this.pipeline.prepare(inputs, {
      origin: 'transaction',
      groupId: txId,
      auth,
      bypassRules: options.bypassRules,
      provenance: options.provenance,
      snapshot: priorDocs,
    });

    if (!('resolvedOps' in prepared)) {
      const event = this.runtime.eventLog.append({
        type: 'transaction',
        method: 'transaction',
        path: '',
        auth: auth ? { uid: auth.uid } : null,
        allowed: false,
        reads: reads.map((read) => ({ path: read.path, data: read.data })),
        operations: mergedOps.map((operation) => ({
          method: operation.method,
          path: operation.path,
          data: operation.data,
          allowed: false,
        })),
        debugMessages: [
          `FieldValue resolve error on '${prepared.input.path}': ${prepared.message}`,
        ],
      });
      this.runtime.emitRequest(prepared.request);
      return {
        allowed: false,
        reads: [...reads],
        writes: inputs.map((input, index) => ({
          path: input.path,
          method: input.ruleMethod,
          allowed: false,
          debugMessages: index === prepared.index ? [prepared.message] : [],
          ...(index === prepared.index ? { error: prepared.error } : {}),
        })),
        returnValue,
        event,
        error: prepared.error,
      };
    }

    const decision = this.pipeline.evaluateAndApply(prepared);
    const writeResults: TransactionResult<R>['writes'] =
      decision.outcomes.map((outcome) => ({
        path: outcome.path,
        method: outcome.method,
        allowed: outcome.allowed,
        debugMessages: outcome.debugMessages,
        ...(outcome.error ? { error: outcome.error } : {}),
      }));
    const event = this.runtime.eventLog.append({
      type: 'transaction',
      method: 'transaction',
      path: '',
      auth: auth ? { uid: auth.uid } : null,
      allowed: decision.allowed,
      reads: reads.map((read) => ({ path: read.path, data: read.data })),
      operations: decision.resolvedOps.map((operation, index) => ({
        method: operation.method,
        path: operation.path,
        data: operation.data,
        allowed: writeResults[index]?.allowed ?? false,
      })),
      snapshot: decision.allowed ? snapshot : undefined,
      debugMessages: decision.allowed
        ? ['Transaction committed']
        : ['Transaction rolled back — one or more operations denied'],
    });

    this.pipeline.emitAndNotify(decision);
    let topError: FirestoreSimError | undefined;
    if (!decision.allowed) {
      topError =
        decision.structuralError ??
        writeResults.find((write) => write.error)?.error ??
        makeError('permission-denied', 'Transaction denied');
    }
    const result: TransactionResult<R> = {
      allowed: decision.allowed,
      reads: [...reads],
      writes: writeResults,
      returnValue,
      event,
      ...(topError ? { error: topError } : {}),
    };
    if (options.readOnly && context.hadWrites()) result.readOnlyViolation = true;
    return result;
  }

  private logAbortedTransaction(
    context: TransactionContext,
    auth: TransactionOptions['auth'],
    error: Error,
  ): void {
    const withCode = error as Error & { code?: unknown };
    const { reads } = context.consume();
    this.runtime.eventLog.append({
      type: 'transaction',
      method: 'transaction',
      path: '',
      auth: auth ? { uid: auth.uid } : null,
      allowed: false,
      aborted: true,
      reads: reads.map((read) => ({ path: read.path, data: read.data })),
      error: {
        name: error.name,
        message: error.message,
        ...(withCode.code !== undefined ? { code: String(withCode.code) } : {}),
      },
      debugMessages: [`Transaction aborted: ${error.message}`],
    });
  }
}
