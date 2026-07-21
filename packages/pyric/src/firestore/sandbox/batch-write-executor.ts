import { makeError, type FirestoreSimError } from './errors.js';
import type {
  BatchOperationInput,
  BatchResult,
  Operation,
} from './writes.js';
import { AtomicWritePipeline } from './atomic-write-pipeline.js';
import { AtomicWriteRuntime } from './atomic-write-runtime.js';

/** Adapts batch inputs and result history to the shared atomic-write pipeline. */
export class BatchWriteExecutor {
  private readonly pipeline: AtomicWritePipeline;

  constructor(private readonly runtime: AtomicWriteRuntime) {
    this.pipeline = new AtomicWritePipeline(runtime);
  }

  batch(
    operations: BatchOperationInput[],
    auth: Operation['auth'],
    bypassRules?: boolean,
  ): BatchResult {
    const snapshot = this.runtime.capturePriors(operations.map((operation) => operation.path));
    const groupId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const inputs = operations.map((operation) => ({
      ...operation,
      ruleMethod: operation.method,
      preData: operation.data,
    }));
    const prepared = this.pipeline.prepare(inputs, {
      origin: 'batch',
      groupId,
      auth,
      bypassRules,
      snapshot,
    });

    if (!('resolvedOps' in prepared)) {
      const event = this.runtime.eventLog.append({
        type: 'batch',
        method: 'batch',
        path: '',
        auth: auth ? { uid: auth.uid } : null,
        allowed: false,
        operations: operations.map((operation) => ({
          method: operation.method,
          path: operation.path,
          data: operation.data,
          allowed: false,
        })),
        debugMessages: [
          `FieldValue resolve error on '${prepared.input.path}': ${prepared.message}`,
        ],
      });
      return {
        allowed: false,
        results: operations.map((operation, index) => ({
          path: operation.path,
          allowed: false,
          debugMessages: [prepared.message],
          ...(index === prepared.index ? { error: prepared.error } : {}),
        })),
        event,
        error: prepared.error,
      };
    }

    const decision = this.pipeline.evaluateAndApply(prepared);
    const results: BatchResult['results'] = decision.outcomes.map((outcome) => ({
      path: outcome.path,
      allowed: outcome.allowed,
      debugMessages: outcome.debugMessages,
      ...(outcome.error ? { error: outcome.error } : {}),
    }));
    const event = this.runtime.eventLog.append({
      type: 'batch',
      method: 'batch',
      path: '',
      auth: auth ? { uid: auth.uid } : null,
      allowed: decision.allowed,
      priorDocs: decision.allowed ? snapshot : undefined,
      operations: decision.resolvedOps.map((operation, index) => ({
        method: operation.method,
        path: operation.path,
        data: operation.data,
        allowed: results[index]?.allowed ?? false,
      })),
      debugMessages: decision.allowed
        ? ['Batch committed']
        : ['Batch rolled back — one or more operations denied'],
    });

    this.pipeline.emitAndNotify(decision);
    let topError: FirestoreSimError | undefined;
    if (!decision.allowed) {
      topError =
        decision.structuralError ??
        results.find((result) => result.error)?.error ??
        makeError('permission-denied', 'Batch denied');
    }
    return {
      allowed: decision.allowed,
      results,
      event,
      ...(topError ? { error: topError } : {}),
    };
  }
}
