import type { DocumentData } from './local-state.js';
import { makeError, type FirestoreEvalRequest, type FirestoreSimError } from './errors.js';
import {
  RetryableTransactionConflictError,
  TransactionAttemptsExhaustedError,
  TransactionContext,
  TransactionReadDeniedError,
  type TransactionReader,
} from './transaction.js';
import type {
  CapturedRead,
  Transaction,
  TransactionOptions,
  TransactionResult,
} from './transaction-types.js';
import { AtomicWritePipeline, type AtomicRuleMethod } from './atomic-write-pipeline.js';
import { WriteRuntime } from './write-runtime.js';
import { renderLegacyDebugMessages, projectEvaluatedRule } from 'pyric/rules/internal';
import {
  SimulatorUnsupportedError,
  unsupportedMessage,
} from './rules-evaluation.js';
import type { EmitRequestInput } from './request-events.js';

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
    const txId = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const txProjection = new Map<string, DocumentData | null>();
    let readDenialError: FirestoreSimError | undefined;
    const reader: TransactionReader = (path) => {
      const data = snapshot[path] ?? null;
      const shouldEvaluateRules = options.bypassRules !== true;
      if (shouldEvaluateRules) {
        const denial = this.evaluateTransactionRead(path, data, options, txId, txProjection);
        const wasDenied = denial !== null;
        if (wasDenied) {
          readDenialError = denial;
          throw new TransactionReadDeniedError(denial);
        }
      }
      return data;
    };
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
      if (error instanceof TransactionReadDeniedError) {
        return this.buildReadDeniedResult(context, options, error.simError);
      }
      if (readDenialError !== undefined) {
        return this.buildReadDeniedResult(context, options, readDenialError);
      }
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
            return this.commitTransaction(
              context,
              snapshot,
              options,
              value,
              attemptVersion,
              txId,
              txProjection,
              readDenialError,
            );
          } catch (error) {
            return this.retryOrThrow(error, fn, options, attempt);
          }
        },
        (error) => {
          if (error instanceof TransactionReadDeniedError) {
            return this.buildReadDeniedResult(context, options, error.simError);
          }
          if (readDenialError !== undefined) {
            return this.buildReadDeniedResult(context, options, readDenialError);
          }
          this.logAbortedTransaction(context, options.auth, error as Error);
          throw error;
        },
      );
    }
    try {
      return this.commitTransaction(
        context,
        snapshot,
        options,
        callbackResult as R,
        attemptVersion,
        txId,
        txProjection,
        readDenialError,
      );
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
    attemptVersion: number,
    txId: string,
    txProjection: Map<string, DocumentData | null>,
    readDenialError?: FirestoreSimError,
  ): TransactionResult<R> {
    const hadReadDenial = readDenialError !== undefined;
    if (hadReadDenial) {
      return this.buildReadDeniedResult(context, options, readDenialError);
    }
    const { reads, writes, readVersions } = context.consume();
    for (const [path, version] of readVersions) {
      const readChanged = this.runtime.state.version(path) !== version;
      if (readChanged) {
        throw new RetryableTransactionConflictError();
      }
    }
    const shouldVerifyReadsAtCommit =
      options.bypassRules !== true &&
      reads.length > 0 &&
      this.runtime.state.currentVersion() !== attemptVersion;
    if (shouldVerifyReadsAtCommit) {
      const commitCheckProjection = new Map(txProjection);
      for (const read of reads) {
        const currentData = this.runtime.state.get(read.path);
        const denial = this.evaluateTransactionRead(
          read.path,
          currentData,
          options,
          txId,
          commitCheckProjection,
        );
        const wasDenied = denial !== null;
        if (wasDenied) {
          return this.buildReadDeniedResult(context, options, denial, reads);
        }
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

    const decision = this.pipeline.evaluateAndApply(prepared, txProjection);
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

  private evaluateTransactionRead(
    path: string,
    prior: DocumentData | null,
    options: TransactionOptions,
    txId: string,
    txProjection: Map<string, DocumentData | null>,
  ): FirestoreSimError | null {
    const evalAt = this.runtime.clock.now();
    const evalStart = performance.now();
    const testCase = this.runtime.buildTestCase({
      method: 'get',
      path,
      auth: options.auth,
    });
    const simulation = this.runtime.runSimulate(
      [testCase],
      options.bypassRules,
      txProjection,
    );
    const evalMs = performance.now() - evalStart;
    const priorExists = prior !== null;

    const simulationFailed = !simulation.success;
    if (simulationFailed) {
      const failedRequest: EmitRequestInput = {
        at: evalAt,
        evalMs,
        method: 'get',
        path,
        auth: options.auth,
        result: 'deny',
        debugMessages: [`Simulation error: ${simulation.error.message}`],
        resourceBefore: { data: prior, exists: priorExists },
        origin: 'transaction',
        groupId: txId,
      };
      const hasProvenance = options.provenance !== undefined;
      if (hasProvenance) failedRequest.provenance = options.provenance;
      this.runtime.emitRequest(failedRequest);
      const error = makeError('invalid-argument', simulation.error.message);
      return error;
    }

    const evaluated = simulation.data.results[0];
    const debugMessages = renderLegacyDebugMessages(evaluated);
    const isUnsupported = evaluated.state === 'UNSUPPORTED';
    if (isUnsupported) {
      const unsupportedRequest: EmitRequestInput = {
        at: evalAt,
        evalMs,
        method: 'get',
        path,
        auth: options.auth,
        result: 'unsupported',
        debugMessages,
        resourceBefore: { data: prior, exists: priorExists },
        origin: 'transaction',
        groupId: txId,
        rulesEvidence: this.runtime.captureEvidence(evaluated),
      };
      const hasProvenance = options.provenance !== undefined;
      if (hasProvenance) unsupportedRequest.provenance = options.provenance;
      this.runtime.emitRequest(unsupportedRequest);
      throw new SimulatorUnsupportedError(
        unsupportedMessage('get', path, debugMessages),
        'get',
        path,
        debugMessages,
      );
    }

    const isAllowed = evaluated.state === 'PASSED';
    if (isAllowed) {
      return null;
    }

    const deniedRequest: EmitRequestInput = {
      at: evalAt,
      evalMs,
      method: 'get',
      path,
      auth: options.auth,
      result: 'deny',
      debugMessages,
      resourceBefore: { data: prior, exists: priorExists },
      origin: 'transaction',
      groupId: txId,
      rulesEvidence: this.runtime.captureEvidence(evaluated),
    };
    const hasProvenance = options.provenance !== undefined;
    if (hasProvenance) deniedRequest.provenance = options.provenance;
    this.runtime.emitRequest(deniedRequest);

    const evalRule = projectEvaluatedRule(evaluated);
    const errExtras: {
      request: FirestoreEvalRequest;
      resource: { data: DocumentData | null; exists: boolean };
      rule?: FirestoreSimError['rule'];
    } = {
      request: {
        method: 'get',
        path,
        auth: options.auth,
      },
      resource: { data: prior, exists: priorExists },
    };
    const hasRule = evalRule !== undefined;
    if (hasRule) {
      errExtras.rule = evalRule;
    }
    const simError = makeError(
      'permission-denied',
      `get ${path} denied by rules`,
      errExtras,
    );
    this.runtime.emitDenial(simError);
    return simError;
  }

  private buildReadDeniedResult<R>(
    context: TransactionContext,
    options: TransactionOptions,
    simError: FirestoreSimError,
    consumedReads?: readonly CapturedRead[],
  ): TransactionResult<R> {
    const reads = consumedReads ?? context.consume().reads;
    const auth = options.auth;
    const hasAuth = auth !== null;
    const event = this.runtime.eventLog.append({
      type: 'transaction',
      method: 'transaction',
      path: '',
      auth: hasAuth ? { uid: auth.uid } : null,
      allowed: false,
      reads: reads.map((read) => ({ path: read.path, data: read.data })),
      operations: [],
      debugMessages: ['Transaction rolled back — read denied by rules'],
    });
    return {
      allowed: false,
      reads: [...reads],
      writes: [],
      returnValue: undefined as unknown as R,
      event,
      error: simError,
    };
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
