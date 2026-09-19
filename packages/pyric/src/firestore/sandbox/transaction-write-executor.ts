import type { DocumentData } from './local-state.js';
import { makeError, type FirestoreSimError } from './errors.js';
import {
  RetryableTransactionConflictError,
  TransactionAttemptsExhaustedError,
  TransactionContext,
  type TransactionReader,
} from './transaction.js';
import type {
  Transaction,
  TransactionOptions,
  TransactionResult,
} from './transaction-types.js';
import { AtomicWritePipeline, type AtomicRuleMethod } from './atomic-write-pipeline.js';
import { WriteRuntime } from './write-runtime.js';

/** Adapts transaction callbacks, ordered writes, and results to the atomic pipeline. */
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
      const hasCapturedVersion = captured !== undefined;
      if (hasCapturedVersion) return captured;
      const current = this.runtime.state.version(path);
      const existedAtStart = current <= attemptVersion;
      return existedAtStart ? current : -1;
    });

    let callbackResult: R | Promise<R>;
    try {
      callbackResult = fn(context);
    } catch (error) {
      this.logAbortedTransaction(context, options.auth, error as Error);
      throw error;
    }

    const isAsyncCallback =
      callbackResult !== null &&
      typeof (callbackResult as PromiseLike<R>)?.then === 'function';
    if (isAsyncCallback) {
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
    const isNonConflictError = !(error instanceof RetryableTransactionConflictError);
    if (isNonConflictError) throw error;
    const maxAttempts = options.maxAttempts ?? 5;
    const attemptsExhausted = attempt >= maxAttempts;
    if (attemptsExhausted) throw new TransactionAttemptsExhaustedError();
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
      const readChanged = this.runtime.state.version(path) !== version;
      if (readChanged) {
        throw new RetryableTransactionConflictError();
      }
    }
    const auth = options.auth;
    const hasNoWrites = writes.length === 0;
    if (hasNoWrites) {
      const hasAuth = auth !== null;
      const event = this.runtime.eventLog.append({
        type: 'transaction',
        method: 'transaction',
        path: '',
        auth: hasAuth ? { uid: auth.uid } : null,
        allowed: true,
        reads: reads.map((read) => ({ path: read.path, data: read.data })),
        operations: [],
        snapshot,
        debugMessages: ['Transaction committed (read-only — no writes queued)'],
      });
      return { allowed: true, reads: [...reads], writes: [], returnValue, event };
    }

    const priorDocs = Object.fromEntries(
      writes.map((operation) => [operation.path, snapshot[operation.path] ?? null]),
    );
    const inputs = writes.map((operation) => {
      const { method } = operation;
      const isSet = method === 'set';
      let ruleMethod: AtomicRuleMethod;
      if (isSet) {
        const documentExists = this.runtime.state.get(operation.path) !== null;
        ruleMethod = documentExists ? 'update' : 'create';
      } else {
        ruleMethod = method;
      }
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

    const preparationFailed = !('resolvedOps' in prepared);
    if (preparationFailed) {
      const hasAuth = auth !== null;
      const event = this.runtime.eventLog.append({
        type: 'transaction',
        method: 'transaction',
        path: '',
        auth: hasAuth ? { uid: auth.uid } : null,
        allowed: false,
        aborted: true,
        error: { name: 'FirebaseError', message: prepared.message, code: prepared.error.code },
        reads: reads.map((read) => ({ path: read.path, data: read.data })),
        operations: writes.map((operation) => ({
          method: operation.method,
          path: operation.path,
          data: operation.data,
          allowed: false,
        })),
        debugMessages: [
          `Write preparation error on '${prepared.input.path}': ${prepared.message}`,
        ],
      });
      this.runtime.emitRequest(prepared.request);
      return {
        allowed: false,
        reads: [...reads],
        writes: this.summarizeWrites(inputs.map((input, index) => {
          const isFailedWrite = index === prepared.index;
          const write: TransactionResult<R>['writes'][number] = {
            path: input.path,
            method: input.ruleMethod,
            allowed: false,
            debugMessages: isFailedWrite ? [prepared.message] : [],
          };
          if (isFailedWrite) write.error = prepared.error;
          return write;
        })),
        returnValue,
        event,
        error: prepared.error,
      };
    }

    const decision = this.pipeline.evaluateAndApply(prepared);
    const writeResults = decision.outcomes.map((outcome) => {
      const write: TransactionResult<R>['writes'][number] = {
        path: outcome.path,
        method: outcome.method,
        allowed: outcome.allowed,
        debugMessages: outcome.debugMessages,
      };
      const hasError = outcome.error !== undefined;
      if (hasError) write.error = outcome.error;
      return write;
    });
    const { allowed } = decision;
    const hasAuth = auth !== null;
    const event = this.runtime.eventLog.append({
      type: 'transaction',
      method: 'transaction',
      path: '',
      auth: hasAuth ? { uid: auth.uid } : null,
      allowed,
      reads: reads.map((read) => ({ path: read.path, data: read.data })),
      operations: decision.resolvedOps.map((operation, index) => ({
        method: operation.method,
        path: operation.path,
        data: operation.data,
        allowed: writeResults[index]?.allowed ?? false,
      })),
      snapshot: allowed ? snapshot : undefined,
      debugMessages: allowed
        ? ['Transaction committed']
        : ['Transaction rolled back — one or more operations denied'],
    });

    this.pipeline.emitAndNotify(decision);
    let topError: FirestoreSimError | undefined;
    const wasDenied = !allowed;
    if (wasDenied) {
      topError =
        decision.structuralError ??
        writeResults.find((write) => write.error)?.error ??
        makeError('permission-denied', 'Transaction denied');
    }
    const result: TransactionResult<R> = {
      allowed,
      reads: [...reads],
      writes: this.summarizeWrites(writeResults),
      returnValue,
      event,
    };
    const hasTopError = topError !== undefined;
    if (hasTopError) result.error = topError;
    const violatedReadOnly = options.readOnly === true && context.hadWrites();
    if (violatedReadOnly) result.readOnlyViolation = true;
    return result;
  }

  private summarizeWrites(writes: TransactionResult['writes']): TransactionResult['writes'] {
    const byPath = new Map<string, TransactionResult['writes'][number]>();
    for (const write of writes) {
      const previous = byPath.get(write.path);
      const isFirstWrite = previous === undefined;
      if (isFirstWrite) {
        byPath.set(write.path, write);
        continue;
      }
      const allowed = previous.allowed && write.allowed;
      const summary: TransactionResult['writes'][number] = {
        path: write.path,
        method: write.method,
        allowed,
        debugMessages: [...previous.debugMessages, ...write.debugMessages],
      };
      const error = previous.error ?? write.error;
      const hasError = error !== undefined;
      if (hasError) summary.error = error;
      byPath.set(write.path, summary);
    }
    return [...byPath.values()];
  }

  private logAbortedTransaction(
    context: TransactionContext,
    auth: TransactionOptions['auth'],
    error: Error,
  ): void {
    const withCode = error as Error & { code?: unknown };
    const { reads } = context.consume();
    const hasAuth = auth !== null;
    const errorDetails: { name: string; message: string; code?: string } = {
      name: error.name,
      message: error.message,
    };
    const hasCode = withCode.code !== undefined;
    if (hasCode) errorDetails.code = String(withCode.code);
    this.runtime.eventLog.append({
      type: 'transaction',
      method: 'transaction',
      path: '',
      auth: hasAuth ? { uid: auth.uid } : null,
      allowed: false,
      aborted: true,
      reads: reads.map((read) => ({ path: read.path, data: read.data })),
      error: errorDetails,
      debugMessages: [`Transaction aborted: ${error.message}`],
    });
  }
}
