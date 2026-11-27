/**
 * The record of runs `fire` caused, read back off the sandbox event stream.
 *
 * The runtime this package wraps had no execution log: the real dev runtime
 * only ever reports an execution to a log line and forgets it. A synthetic
 * call needs somewhere to read that history back from, and that somewhere is
 * the stream every other service already lands on, so `fire` emits one
 * `execution_finished` event per run and this module folds those events back
 * into the records a caller reads. There is no second copy to drift from it.
 */
import type { LocalSandbox, SandboxEvent } from 'pyric/sandbox';
import { emitExecutionFinished, type FunctionExecutionOutcome } from './events.js';
import { redactActiveSecretString, redactActiveSecretValue } from './secret-redaction.js';

/** One run `fire` caused. */
export interface FunctionExecutionRecord {
  /** Stable id, assigned in the order runs finished. */
  id: string;
  /** The trigger export name `fire` ran. */
  trigger: string;
  /** The concrete path and params the synthetic event carried. */
  cause: { ref: string; params: Record<string, string> };
  /** Sandbox clock instant the run started, in epoch milliseconds. */
  startedAt: number;
  durationMs: number;
  status: 'fulfilled' | 'rejected' | 'timeout';
  /** What the handler returned, present only when `status` is `fulfilled`. */
  result?: unknown;
  /** The handler's thrown error, present only when `status` is `rejected`. */
  error?: string;
  /** Retry configuration metadata when emitted by a retriable trigger family. */
  retryConfig?: Record<string, number>;
}

/** Whether one event is a finished Functions run. */
function isExecutionFinished(event: SandboxEvent): boolean {
  if (event.kind !== 'service_mutation') return false;
  if (event.service !== 'functions') return false;
  return event.op === 'execution_finished';
}

/** The finished-run events this sandbox carries, in the order they landed. */
function finishedRuns(sandbox: LocalSandbox): SandboxEvent[] {
  return sandbox.history().filter(isExecutionFinished);
}

/**
 * The id the next run to finish will carry.
 *
 * Ids count the finished runs the stream already holds, so they stay the
 * one-based sequence a caller saw before the log became a fold, and a restore
 * that replaces the stream renumbers with it rather than drifting past it.
 */
export function executionIdFor(sandbox: LocalSandbox): string {
  return String(finishedRuns(sandbox).length + 1);
}

/** Rebuild one record from the event that reported the run. */
function toRecord(event: SandboxEvent, ordinal: number): FunctionExecutionRecord {
  const mutation = event as { path?: string; detail?: Record<string, unknown> };
  const detail = mutation.detail ?? {};
  const record: FunctionExecutionRecord = {
    id: String(ordinal),
    trigger: String(detail.trigger),
    cause: {
      ref: mutation.path ?? '',
      params: (detail.params as Record<string, string> | undefined) ?? {},
    },
    startedAt: Number(detail.startedAt),
    durationMs: Number(detail.durationMs),
    status: statusOf(detail.status),
  };
  if (record.status === 'fulfilled') record.result = detail.result;
  if (record.status === 'rejected') record.error = String(detail.error);
  if (typeof detail.retryConfig === 'object' && detail.retryConfig !== null) {
    record.retryConfig = detail.retryConfig as Record<string, number>;
  }
  return record;
}

/** Emit one finished run onto `sandbox` and return its folded execution record. */
export function recordFunctionExecution(
  sandbox: LocalSandbox,
  outcome: FunctionExecutionOutcome,
): FunctionExecutionRecord {
  const id = executionIdFor(sandbox);
  emitExecutionFinished(sandbox, outcome);
  const record: FunctionExecutionRecord = {
    id,
    trigger: outcome.trigger,
    cause: {
      ref: redactActiveSecretString(outcome.ref),
      params: redactActiveSecretValue(outcome.params),
    },
    startedAt: outcome.startedAt,
    durationMs: outcome.durationMs,
    status: outcome.status,
  };
  if (outcome.status === 'fulfilled') record.result = redactActiveSecretValue(outcome.result);
  if (outcome.status === 'rejected') {
    record.error = redactActiveSecretString(outcome.error ?? 'Unknown error');
  }
  if (outcome.retryConfig !== undefined) record.retryConfig = outcome.retryConfig;
  return record;
}

/** Every run at or after `since`, in the order they finished. */
export function listExecutions(
  sandbox: LocalSandbox,
  since?: number,
): FunctionExecutionRecord[] {
  const records = finishedRuns(sandbox).map((event, index) => toRecord(event, index + 1));
  if (since === undefined) return records;
  return records.filter((record) => record.startedAt >= since);
}

/** The record status an emitted outcome status folds to. */
function statusOf(status: unknown): FunctionExecutionRecord['status'] {
  if (status === 'rejected') return 'rejected';
  if (status === 'timeout') return 'timeout';
  return 'fulfilled';
}
