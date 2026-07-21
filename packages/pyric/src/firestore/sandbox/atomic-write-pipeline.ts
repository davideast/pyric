import type { BatchOperation, DocumentData } from './local-state.js';
import { resolveValueTree, type ResolveMethod } from './value-resolver.js';
import { makeError, type FirestoreSimError } from './errors.js';
import { renderLegacyDebugMessages, Timestamp } from 'pyric/rules/internal';
import {
  SimulatorUnsupportedError,
  unsupportedMessage,
} from './rules-evaluation.js';
import type { Operation } from './writes.js';
import type { EventProvenance } from '../../sandbox/types/events.js';
import type { EmitRequestInput } from './request-events.js';
import { walkForSentinels } from './sentinel-capture.js';
import { WriteRuntime } from './write-runtime.js';

export type AtomicRuleMethod = 'create' | 'update' | 'delete';
export type AtomicOrigin = 'batch' | 'transaction';

export interface AtomicWriteInput {
  method: BatchOperation['method'];
  ruleMethod: AtomicRuleMethod;
  path: string;
  data?: DocumentData;
  preData?: DocumentData;
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

export interface AtomicResolutionFailure {
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
  ): AtomicPreparation | AtomicResolutionFailure {
    const serverTime = Timestamp.fromMillis(Date.now());
    const resolvedOps: BatchOperation[] = [];
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index]!;
      try {
        const data = input.data
          ? resolveValueTree({ ...input.data }, {
              path: input.path,
              method: input.method as ResolveMethod,
              prior: this.runtime.state.get(input.path),
              serverTime,
            })
          : input.data;
        resolvedOps.push({ method: input.method, path: input.path, data });
      } catch (error) {
        const message = (error as Error).message;
        const wrapped = makeError('invalid-argument', message);
        const prior = context.snapshot[input.path] ?? null;
        const request: EmitRequestInput = {
          at: Date.now(),
          evalMs: 0,
          method: input.ruleMethod,
          path: input.path,
          auth: context.auth,
          result: 'deny',
          debugMessages: [`FieldValue resolve error: ${message}`],
          ...(this.includesRequestData(context, input)
            ? { resourceData: input.preData }
            : {}),
          resourceBefore: { data: prior, exists: prior !== null },
          origin: context.origin,
          groupId: context.groupId,
          ...(context.bypassRules ? { detail: { admin: true } } : {}),
          ...(context.provenance ? { provenance: context.provenance } : {}),
        };
        return { index, input, message, error: wrapped, request };
      }
    }
    return { context, inputs, resolvedOps, serverTime };
  }

  evaluateAndApply(prepared: AtomicPreparation): AtomicDecision {
    const { context, inputs, resolvedOps, serverTime } = prepared;
    const testCases = resolvedOps.map((operation, index) => {
      const input = inputs[index]!;
      return this.runtime.buildTestCase({
        method: input.ruleMethod,
        path: operation.path,
        auth: context.auth,
        data: operation.data,
      }, serverTime);
    });
    const projection = this.runtime.buildBatchProjection(testCases);
    const outcomes: AtomicWriteOutcome[] = [];
    let allowed = true;

    for (let index = 0; index < resolvedOps.length; index++) {
      const operation = resolvedOps[index]!;
      const input = inputs[index]!;
      const prior = context.snapshot[input.path] ?? null;
      const evalAt = Date.now();
      const evalStart = performance.now();
      const simulation = this.runtime.runSimulate(
        [testCases[index]!],
        context.bypassRules,
        projection,
      );
      const evalMs = performance.now() - evalStart;

      if (!simulation.success) {
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

      const evaluated = simulation.data.results[0]!;
      const debugMessages = renderLegacyDebugMessages(evaluated);
      if (evaluated.state === 'UNSUPPORTED') {
        this.runtime.emitRequest(this.request(
          prepared,
          input,
          prior,
          evalAt,
          evalMs,
          'unsupported',
          debugMessages,
        ));
        throw new SimulatorUnsupportedError(
          unsupportedMessage(input.ruleMethod, input.path, debugMessages),
          input.ruleMethod,
          input.path,
          debugMessages,
        );
      }

      const isAllowed = evaluated.state === 'PASSED';
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
          isAllowed ? 'allow' : 'deny',
          debugMessages,
        ),
      };
      if (!isAllowed) {
        outcome.error = makeError(
          'permission-denied',
          `${input.ruleMethod} ${input.path} denied by rules`,
          {
            request: {
              method: input.ruleMethod,
              path: input.path,
              auth: context.auth,
              ...(this.includesRequestData(context, input)
                ? { resourceData: input.preData }
                : {}),
            },
            resource: { data: prior, exists: prior !== null },
          },
        );
        this.runtime.emitDenial(outcome.error);
        allowed = false;
      }
      outcomes.push(outcome);
    }

    let structuralError: FirestoreSimError | null = null;
    if (allowed) {
      const applied = this.runtime.state.applyBatch(resolvedOps);
      if (!applied.success) {
        allowed = false;
        const first = applied.errors?.[0];
        if (first !== undefined) {
          const failed = resolvedOps[first.index];
          structuralError = makeError(
            failed?.method === 'create' ? 'already-exists' : 'not-found',
            first.error,
          );
          const outcome = outcomes[first.index];
          if (outcome) {
            outcome.allowed = false;
            outcome.error = structuralError;
          }
        }
      }
    }

    return { ...prepared, outcomes, allowed, structuralError };
  }

  emitAndNotify(decision: AtomicDecision): void {
    const { context, inputs, outcomes, serverTime } = decision;
    for (let index = 0; index < outcomes.length; index++) {
      const outcome = outcomes[index]!;
      const input = inputs[index]!;
      const committed = decision.allowed && outcome.allowed;
      const prior = context.snapshot[input.path] ?? null;
      outcome.request.resourceAfter = committed
        ? input.ruleMethod === 'delete'
          ? { data: null, exists: false }
          : {
              data: this.runtime.state.get(input.path),
              exists: this.runtime.state.get(input.path) !== null,
            }
        : { data: prior, exists: prior !== null };
      this.runtime.emitRequest(outcome.request);

      if (committed) {
        const sentinels = input.preData ? walkForSentinels(input.preData) : undefined;
        this.runtime.emitWrite({
          method: input.ruleMethod,
          path: input.path,
          auth: context.auth,
          ...(input.ruleMethod !== 'delete' && input.preData
            ? { data: input.preData }
            : {}),
          priorState: prior,
          nextState: input.ruleMethod === 'delete'
            ? null
            : this.runtime.state.get(input.path),
          groupId: context.groupId,
          groupKind: context.origin,
          ...(sentinels && sentinels.length > 0 ? { sentinels } : {}),
          requestTime: serverTime,
          ...(context.bypassRules ? { detail: { admin: true } } : {}),
          ...(context.provenance ? { provenance: context.provenance } : {}),
        });
      }
    }

    if (decision.allowed) {
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
    return {
      at,
      evalMs,
      method: input.ruleMethod,
      path: input.path,
      auth: context.auth,
      result,
      debugMessages,
      ...(this.includesRequestData(context, input)
        ? { resourceData: input.preData }
        : {}),
      resourceBefore: { data: prior, exists: prior !== null },
      origin: context.origin,
      groupId: context.groupId,
      ...(context.bypassRules ? { detail: { admin: true } } : {}),
      ...(context.provenance ? { provenance: context.provenance } : {}),
    };
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
