/**
 * Run one discovered trigger on a synthetic event built from `path` and
 * `value`, the way the real runtime's event builder shapes a create event:
 * a `path` matched against the trigger's own reference pattern to capture its
 * wildcard params, and `value` carried as the delta a create event never had
 * a "before" for. Nothing is written to the database; the handler runs
 * against an event that only claims the write happened.
 *
 * Executes inside an isolated `@pyric/cli/register`-guarded child process
 * (`functions-runtime.ts`) so user Functions code runs under Swap-or-Stop with
 * `GOOGLE_APPLICATION_CREDENTIALS` stripped, ambient `pyric-admin` connected to
 * `ctx.sandbox`, and fresh module exports on every edit.
 */
import { z } from 'zod';
import {
  emitExecutionFinished,
  emitHandlerFired,
  emitTriggerDiscovered,
} from '../../../../functions/events.js';
import {
  executionIdFor,
  type FunctionExecutionRecord,
} from '../../../../functions/execution-log.js';
import { normalizeRtdbReference } from '../../../../functions/rtdb/reference-pattern.js';
import { pathArgument, timeoutMsArgument, triggerArgument, valueArgument } from '../../arguments/functions.js';
import { operationFailure } from '../../context.js';
import { fireFunctionsTriggerIsolated } from '../../functions-runtime.js';
import type { MethodRecord } from '../../method-types.js';
import type { SurfaceContext } from '../../types.js';

/** The bound `fire` applies when the caller does not name a `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Report a run that never settled onto the stream, and read back its record. */
function reportTimeout(
  ctx: SurfaceContext,
  triggerName: string,
  ref: string,
  params: Record<string, string>,
  startedAt: number,
  durationMs: number,
): FunctionExecutionRecord {
  const id = executionIdFor(ctx.sandbox);
  const record: FunctionExecutionRecord = {
    id,
    trigger: triggerName,
    cause: { ref, params },
    startedAt,
    durationMs,
    status: 'timeout',
  };
  emitExecutionFinished(ctx.sandbox, {
    trigger: triggerName,
    ref,
    params,
    startedAt,
    durationMs,
    status: 'timeout',
  });
  return record;
}

/** Report one finished run onto the stream, and read back the record it became. */
function reportExecution(
  ctx: SurfaceContext,
  triggerName: string,
  ref: string,
  params: Record<string, string>,
  startedAt: number,
  durationMs: number,
  outcome: {
    status: 'fulfilled' | 'rejected';
    result?: unknown;
    errorMessage?: string;
  },
): FunctionExecutionRecord {
  const id = executionIdFor(ctx.sandbox);
  const record: FunctionExecutionRecord = {
    id,
    trigger: triggerName,
    cause: { ref, params },
    startedAt,
    durationMs,
    status: outcome.status,
  };
  if (outcome.status === 'fulfilled') record.result = outcome.result;
  if (outcome.status === 'rejected') record.error = outcome.errorMessage ?? 'Unknown error';
  emitExecutionFinished(ctx.sandbox, {
    trigger: triggerName,
    ref,
    params,
    startedAt,
    durationMs,
    status: record.status,
    result: record.result,
    error: record.error,
  });
  return record;
}

export default {
  tool: 'functions',
  method: 'fire',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'fire(trigger, path, value, timeoutMs?)',
  description:
    'Run a discovered trigger on a synthetic event built from path and value. Does not write value at path. Refuses if the handler does not settle within timeoutMs (default 10000, max 60000).',
  args: z.object({
    trigger: triggerArgument,
    path: pathArgument,
    value: valueArgument,
    timeoutMs: timeoutMsArgument,
  }),
  operation: 'fire_functions_trigger',
  example: { trigger: 'makeUppercase', path: 'messages/abc123/original', value: 'hello' },
  async handler(args, ctx) {
    const triggerName = String(args.trigger);
    const path = String(args.path);
    const ref = normalizeRtdbReference(path);
    const timeoutMs = (args.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS;

    const outcome = await fireFunctionsTriggerIsolated(ctx, {
      triggerName,
      path,
      ref,
      value: args.value,
      timeoutMs,
      onFiring(trigger, params) {
        emitTriggerDiscovered(ctx.sandbox, trigger);
        emitHandlerFired(ctx.sandbox, { trigger: triggerName, ref, params });
      },
    });

    if (outcome.kind === 'not-found') {
      return operationFailure(
        `functions.fire: '${triggerName}' does not name a discovered trigger. Call functions' listTriggers method to see the triggers this project defines.`,
      );
    }
    if (outcome.kind === 'mismatch') {
      return operationFailure(
        `functions.fire: '${path}' does not match ${triggerName}'s reference pattern '${outcome.trigger.reference}'.`,
      );
    }
    if (outcome.kind === 'timed-out') {
      const record = reportTimeout(
        ctx,
        triggerName,
        ref,
        outcome.params,
        outcome.startedAt,
        outcome.durationMs,
      );
      return operationFailure(
        `functions.fire: ${triggerName} did not settle within ${timeoutMs}ms and was refused as timed out.`,
        { executionId: record.id },
      );
    }

    const record = reportExecution(
      ctx,
      triggerName,
      ref,
      outcome.params,
      outcome.startedAt,
      outcome.durationMs,
      outcome,
    );
    if (outcome.status === 'rejected') {
      return operationFailure(`functions.fire: ${triggerName} threw: ${record.error}`, {
        executionId: record.id,
        event: outcome.event,
      });
    }
    return {
      ok: true,
      summary: `Ran ${triggerName} on a synthetic event at ${ref}; ${path} was not written.`,
      data: { executionId: record.id, event: outcome.event, result: outcome.result },
    };
  },
} satisfies MethodRecord;
