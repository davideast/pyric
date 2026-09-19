import type { BatchOperation, DocumentData } from './local-state.js';
import { resolveValueTree, type ResolveMethod } from './value-resolver.js';
import { makeError, type FirestoreEvalRequest, type FirestoreSimError } from './errors.js';
import { renderLegacyDebugMessages, Timestamp, projectEvaluatedRule } from 'pyric/rules/internal';
import {

  SimulatorUnsupportedError,
  unsupportedMessage,
} from './rules-evaluation.js';
import type { Operation } from './writes.js';
import type { EventProvenance } from '../../sandbox/types/events.js';
import type { EmitRequestInput } from './request-events.js';
import { walkForSentinels } from './sentinel-capture.js';
import { applyMerge } from './field-merge.js';
import { WriteRuntime } from './write-runtime.js';

export type AtomicRuleMethod = 'create' | 'update' | 'delete';
export type AtomicOrigin = 'batch' | 'transaction';

export interface AtomicWriteInput {
  method: BatchOperation['method'];
  ruleMethod: AtomicRuleMethod;
  path: string;
  data?: DocumentData;
  preData?: DocumentData;
  merge?: Operation['merge'];
}

export interface AtomicWriteContext {
  origin: AtomicOrigin;
  groupId: string;
  auth: Operation['auth'];
  bypassRules?: boolean;
  provenance?: EventProvenance;
  snapshot: Record<string, DocumentData | null>;
}

export interface AtomicPreparation {
  context: AtomicWriteContext;
  inputs: AtomicWriteInput[];
  resolvedOps: BatchOperation[];
  serverTime: Timestamp;
}

export interface AtomicPreparationFailure {
  index: number;
  input: AtomicWriteInput;
  message: string;
  error: FirestoreSimError;
  request: EmitRequestInput;
}

export interface AtomicWriteOutcome {
  path: string;
  method: AtomicRuleMethod;
  allowed: boolean;
  debugMessages: string[];
  error?: FirestoreSimError;
  request: EmitRequestInput;
}

export interface AtomicDecision extends AtomicPreparation {
  outcomes: AtomicWriteOutcome[];
  allowed: boolean;
  structuralError: FirestoreSimError | null;
}

/**
 * One owner for the atomic resolve → evaluate → apply → emit pipeline.
 * Batch and transaction executors adapt only their distinct inputs and results.
 */
export class AtomicWritePipeline {
  constructor(private readonly runtime: WriteRuntime) {}

  prepare(
    inputs: AtomicWriteInput[],
    context: AtomicWriteContext,
  ): AtomicPreparation | AtomicPreparationFailure {
    const serverTime = Timestamp.fromMillis(this.runtime.clock.now());
    const resolvedOps: BatchOperation[] = [];
    const projection = new Map<string, DocumentData | null>();
    for (const [index, input] of inputs.entries()) {
      try {
        const updatesDeletedDocument = input.method === 'update' && projection.get(input.path) === null;
        if (updatesDeletedDocument) {
          throw new Error(`Cannot delete then update document '${input.path}' in the same atomic write.`);
        }
        const hasData = input.data !== undefined;
        let data = input.data;
        if (hasData) {
          const hasEarlierWrite = projection.has(input.path);
          let prior: DocumentData | null;
          if (hasEarlierWrite) {
            prior = projection.get(input.path) ?? null;
          } else {
            prior = this.runtime.state.get(input.path);
          }
          data = resolveValueTree({ ...input.data }, {
            path: input.path,
            method: input.method as ResolveMethod,
            prior,
            serverTime,
          });
          const { merge } = input;
          const hasMerge = merge !== undefined && merge !== false;
          if (hasMerge) {
            const mergesAllFields = merge === true;
            const mergeFields = mergesAllFields ? undefined : merge.mergeFields;
            data = applyMerge(prior ?? {}, data, mergeFields);
          }
        }
        const resolved = { method: input.method, path: input.path, data };
        resolvedOps.push(resolved);
        this.runtime.buildBatchProjection([resolved], projection);
      } catch (error) {
        const message = (error as Error).message;
        const wrapped = makeError('invalid-argument', message);
        const prior = context.snapshot[input.path] ?? null;
        const request: EmitRequestInput = {
          at: this.runtime.clock.now(),
          evalMs: 0,
          method: input.ruleMethod,
          path: input.path,
          auth: context.auth,
          result: 'deny',
          debugMessages: [`Write preparation error: ${message}`],
          resourceBefore: { data: prior, exists: prior !== null },
          origin: context.origin,
          groupId: context.groupId,
        };
        const includesData = this.includesRequestData(context, input);
        if (includesData) request.resourceData = input.preData;
        const bypassesRules = context.bypassRules === true;
        if (bypassesRules) request.detail = { admin: true };
        const hasProvenance = context.provenance !== undefined;
        if (hasProvenance) request.provenance = context.provenance;
        return { index, input, message, error: wrapped, request };
      }
    }
    return { context, inputs, resolvedOps, serverTime };
  }

  evaluateAndApply(prepared: AtomicPreparation): AtomicDecision {
    const { context, resolvedOps, serverTime } = prepared;
    const projection = this.runtime.buildBatchProjection(resolvedOps);
    const inputs = prepared.inputs.map((input) => {
      const hasExplicitRuleMethod = input.method !== 'set';
      if (hasExplicitRuleMethod) return input;
      const deletesDocument = projection.get(input.path) === null;
      let ruleMethod: AtomicRuleMethod;
      if (deletesDocument) {
        ruleMethod = 'delete';
      } else {
        const documentExists = this.runtime.state.get(input.path) !== null;
        ruleMethod = documentExists ? 'update' : 'create';
      }
      return { ...input, ruleMethod };
    });
    const testCases = resolvedOps.map((operation, index) => {
      const testCase = this.runtime.buildTestCase({
        method: inputs[index].ruleMethod,
        path: operation.path,
        auth: context.auth,
        data: operation.data,
      }, serverTime);
      // Atomic request.resource and getAfter both describe the final document.
      testCase.data = projection.get(operation.path) ?? undefined;
      return testCase;
    });
    const outcomes: AtomicWriteOutcome[] = [];
    let allowed = true;

    for (const [index] of resolvedOps.entries()) {
      const input = inputs[index];
      const prior = context.snapshot[input.path] ?? null;
      const evalAt = this.runtime.clock.now();
      const evalStart = performance.now();
      const simulation = this.runtime.runSimulate(
        [testCases[index]],
        context.bypassRules,
        projection,
      );
      const evalMs = performance.now() - evalStart;

      const simulationFailed = !simulation.success;
      if (simulationFailed) {
        const error = makeError('invalid-argument', simulation.error.message);
        outcomes.push({
          path: input.path,
          method: input.ruleMethod,
          allowed: false,
          debugMessages: [simulation.error.message],
          error,
          request: this.request(
            prepared,
            input,
            prior,
            evalAt,
            evalMs,
            'deny',
            [`Simulation error: ${simulation.error.message}`],
          ),
        });
        allowed = false;
        continue;
      }

      const evaluated = simulation.data.results[0];
      const debugMessages = renderLegacyDebugMessages(evaluated);
      const isUnsupported = evaluated.state === 'UNSUPPORTED';
      if (isUnsupported) {
        const unsupportedRequest = this.request(
          prepared,
          input,
          prior,
          evalAt,
          evalMs,
          'unsupported',
          debugMessages,
        );
        unsupportedRequest.rulesEvidence = this.runtime.captureEvidence(evaluated);
        this.runtime.emitRequest(unsupportedRequest);
        throw new SimulatorUnsupportedError(
          unsupportedMessage(input.ruleMethod, input.path, debugMessages),
          input.ruleMethod,
          input.path,
          debugMessages,
        );
      }

      const isAllowed = evaluated.state === 'PASSED';
      let resultStr: 'allow' | 'deny' = 'deny';
      if (isAllowed) {
        resultStr = 'allow';
      }
      const outcome: AtomicWriteOutcome = {
        path: input.path,
        method: input.ruleMethod,
        allowed: isAllowed,
        debugMessages,
        request: this.request(
          prepared,
          input,
          prior,
          evalAt,
          evalMs,
          resultStr,
          debugMessages,
        ),
      };
      outcome.request.rulesEvidence = this.runtime.captureEvidence(evaluated);
      const isDenied = !isAllowed;
      if (isDenied) {
        const evalRule = projectEvaluatedRule(evaluated);
        const isPriorNotNull = prior !== null;
        const errExtras: {
          request: FirestoreEvalRequest;
          resource: { data: DocumentData | null; exists: boolean };
          rule?: FirestoreSimError['rule'];
        } = {
          request: {
            method: input.ruleMethod,
            path: input.path,
            auth: context.auth,
          },
          resource: { data: prior, exists: isPriorNotNull },
        };
        const incData = this.includesRequestData(context, input);
        if (incData) {
          errExtras.request.resourceData = input.preData;
        }
        const hasRule = evalRule !== undefined;
        if (hasRule) {
          errExtras.rule = evalRule;
        }
        outcome.error = makeError(
          'permission-denied',
          `${input.ruleMethod} ${input.path} denied by rules`,
          errExtras,
        );
        this.runtime.emitDenial(outcome.error);
        allowed = false;
      }
      outcomes.push(outcome);
    }

    let structuralError: FirestoreSimError | null = null;
    if (allowed) {
      const applied = this.runtime.state.applyBatch(resolvedOps);
      const applicationFailed = !applied.success;
      if (applicationFailed) {
        allowed = false;
        const first = applied.errors?.[0];
        const hasFailure = first !== undefined;
        if (hasFailure) {
          const failed = resolvedOps[first.index];
          const failedCreate = failed?.method === 'create';
          structuralError = makeError(
            failedCreate ? 'already-exists' : 'not-found',
            first.error,
          );
          const outcome = outcomes[first.index];
          const hasOutcome = outcome !== undefined;
          if (hasOutcome) {
            outcome.allowed = false;
            outcome.error = structuralError;
          }
        }
      }
    }

    return { ...prepared, inputs, outcomes, allowed, structuralError };
  }

  emitAndNotify(decision: AtomicDecision): void {
    const { context, inputs, outcomes, serverTime } = decision;
    for (const [index, outcome] of outcomes.entries()) {
      const input = inputs[index];
      const committed = decision.allowed && outcome.allowed;
      const prior = context.snapshot[input.path] ?? null;
      if (committed) {
        const isDelete = input.ruleMethod === 'delete';
        outcome.request.resourceAfter = isDelete
          ? { data: null, exists: false }
          : {
              data: this.runtime.state.get(input.path),
              exists: this.runtime.state.get(input.path) !== null,
            };
      } else {
        outcome.request.resourceAfter = { data: prior, exists: prior !== null };
      }
      this.runtime.emitRequest(outcome.request);

      if (committed) {
        const hasPreData = input.preData !== undefined;
        const sentinels = hasPreData ? walkForSentinels(input.preData) : undefined;
        const isDelete = input.ruleMethod === 'delete';
        const write: Parameters<WriteRuntime['emitWrite']>[0] = {
          method: input.ruleMethod,
          path: input.path,
          auth: context.auth,
          priorState: prior,
          nextState: isDelete ? null : this.runtime.state.get(input.path),
          groupId: context.groupId,
          groupKind: context.origin,
          requestTime: serverTime,
        };
        const includesData = !isDelete && hasPreData;
        if (includesData) write.data = input.preData;
        const hasSentinels = sentinels !== undefined && sentinels.length > 0;
        if (hasSentinels) write.sentinels = sentinels;
        const bypassesRules = context.bypassRules === true;
        if (bypassesRules) write.detail = { admin: true };
        const hasProvenance = context.provenance !== undefined;
        if (hasProvenance) write.provenance = context.provenance;
        this.runtime.emitWrite(write);
      }
    }

    const { allowed } = decision;
    if (allowed) {
      this.runtime.notify(
        context.origin,
        inputs[0]?.path ?? '',
        new Set(inputs.map((input) => input.path)),
      );
    }
  }

  private request(
    prepared: AtomicPreparation,
    input: AtomicWriteInput,
    prior: DocumentData | null,
    at: number,
    evalMs: number,
    result: EmitRequestInput['result'],
    debugMessages: string[],
  ): EmitRequestInput {
    const { context } = prepared;
    const request: EmitRequestInput = {
      at,
      evalMs,
      method: input.ruleMethod,
      path: input.path,
      auth: context.auth,
      result,
      debugMessages,
      resourceBefore: { data: prior, exists: prior !== null },
      origin: context.origin,
      groupId: context.groupId,
    };
    const includesData = this.includesRequestData(context, input);
    if (includesData) request.resourceData = input.preData;
    const bypassesRules = context.bypassRules === true;
    if (bypassesRules) request.detail = { admin: true };
    const hasProvenance = context.provenance !== undefined;
    if (hasProvenance) request.provenance = context.provenance;
    return request;
  }

  private includesRequestData(
    context: AtomicWriteContext,
    input: AtomicWriteInput,
  ): input is AtomicWriteInput & { preData: DocumentData } {
    return input.preData !== undefined && (
      context.origin === 'batch' || input.ruleMethod !== 'delete'
    );
  }
}
