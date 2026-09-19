import { makeError, type FirestoreSimError } from './errors.js';
import type {
  BatchOperationInput,
  BatchResult,
  Operation,
} from './writes.js';
import { AtomicWritePipeline, type AtomicRuleMethod } from './atomic-write-pipeline.js';
import { WriteRuntime } from './write-runtime.js';

/** Adapts batch inputs and result history to the shared atomic-write pipeline. */
export class BatchWriteExecutor {
  private readonly pipeline: AtomicWritePipeline;

  constructor(private readonly runtime: WriteRuntime) {
    this.pipeline = new AtomicWritePipeline(runtime);
  }

  batch(
    operations: BatchOperationInput[],
    auth: Operation['auth'],
    bypassRules?: boolean,
  ): BatchResult {
    const snapshot = this.runtime.capturePriors(operations.map((operation) => operation.path));
    const groupId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const inputs = operations.map((operation) => {
      const { method } = operation;
      const isReplacement = method === 'set';
      let ruleMethod: AtomicRuleMethod;
      if (isReplacement) {
        const documentExists = snapshot[operation.path] !== null;
        ruleMethod = documentExists ? 'update' : 'create';
      } else {
        ruleMethod = method;
      }
      return { ...operation, ruleMethod, preData: operation.data };
    });
    const prepared = this.pipeline.prepare(inputs, {
      origin: 'batch',
      groupId,
      auth,
      bypassRules,
      snapshot,
    });

    const hasAuth = auth !== null;
    const eventAuth = hasAuth ? { uid: auth.uid } : null;
    const preparationFailed = !('resolvedOps' in prepared);
    if (preparationFailed) {
      const event = this.runtime.eventLog.append({
        type: 'batch',
        method: 'batch',
        path: '',
        auth: eventAuth,
        allowed: false,
        operations: operations.map((operation) => ({
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
        results: operations.map((operation) => {
          const result: BatchResult['results'][number] = {
            path: operation.path,
            allowed: false,
            debugMessages: [prepared.message],
          };
          const isFailedPath = operation.path === prepared.input.path;
          if (isFailedPath) result.error = prepared.error;
          return result;
        }),
        event,
        error: prepared.error,
      };
    }

    const decision = this.pipeline.evaluateAndApply(prepared);
    const results = decision.outcomes.map((outcome) => {
      const result: BatchResult['results'][number] = {
        path: outcome.path,
        allowed: outcome.allowed,
        debugMessages: outcome.debugMessages,
      };
      const hasError = outcome.error !== undefined;
      if (hasError) result.error = outcome.error;
      return result;
    });
    const { allowed } = decision;
    const event = this.runtime.eventLog.append({
      type: 'batch',
      method: 'batch',
      path: '',
      auth: eventAuth,
      allowed,
      priorDocs: allowed ? snapshot : undefined,
      operations: decision.resolvedOps.map((operation, index) => ({
        method: operation.method,
        path: operation.path,
        data: operation.data,
        allowed: results[index]?.allowed ?? false,
      })),
      debugMessages: allowed
        ? ['Batch committed']
        : ['Batch rolled back — one or more operations denied'],
    });

    this.pipeline.emitAndNotify(decision);
    let topError: FirestoreSimError | undefined;
    const wasDenied = !allowed;
    if (wasDenied) {
      topError =
        decision.structuralError ??
        results.find((result) => result.error)?.error ??
        makeError('permission-denied', 'Batch denied');
    }
    const result: BatchResult = {
      allowed,
      results,
      event,
    };
    const hasTopError = topError !== undefined;
    if (hasTopError) result.error = topError;
    return result;
  }
}
