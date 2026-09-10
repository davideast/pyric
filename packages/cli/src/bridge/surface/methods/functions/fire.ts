/**
 * Run one discovered trigger on a synthetic event built from `path` and
 * `value`, the way the real runtime's event builder shapes a create event:
 * a `path` matched against the trigger's own reference pattern to capture its
 * wildcard params, and `value` carried as the delta a create event never had
 * a "before" for. Nothing is written to the database; the handler runs
 * against an event that only claims the write happened.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getClock } from 'pyric/sandbox';
import { resolveChildDatabaseHost, resolveChildProjectId } from '../../../../functions-rtdb/child.js';
import {
  executeOnValueCreated,
  type CreatedEventOptions,
  type CreatedExecutionResult,
} from '../../../../functions-rtdb/event.js';
import type { DiscoveredOnValueCreated } from '../../../../functions-rtdb/discovery.js';
import {
  executionLogFor,
  type FunctionExecutionEntry,
  type FunctionExecutionRecord,
} from '../../../../functions-rtdb/execution-log.js';
import { matchRtdbReference, normalizeRtdbReference } from '../../../../functions-rtdb/reference-pattern.js';
import { pathArgument, triggerArgument, valueArgument } from '../../arguments/functions.js';
import { operationFailure } from '../../context.js';
import { discoverFunctionsTriggers } from '../../functions-runtime.js';
import type { MethodRecord } from '../../method-types.js';
import type { SurfaceContext } from '../../types.js';

const DEFAULT_LOCATION = 'us-central1';

/** The trigger error a thrown handler value reads as. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The instant, database instance, region, and host a synthetic event stamps. */
function eventOptionsFor(
  ctx: SurfaceContext,
  trigger: DiscoveredOnValueCreated,
): CreatedEventOptions {
  const projectId = resolveChildProjectId();
  let instance = trigger.instance;
  if (instance === '*') instance = `${projectId}-default-rtdb`;
  return {
    id: randomUUID(),
    time: new Date(getClock(ctx.sandbox).now()).toISOString(),
    instance,
    location: trigger.location ?? DEFAULT_LOCATION,
    databaseHost: resolveChildDatabaseHost(),
  };
}

/** Record one finished run, folding in the result or the error the handler produced. */
function logExecution(
  ctx: SurfaceContext,
  triggerName: string,
  ref: string,
  params: Record<string, string>,
  startedAt: number,
  durationMs: number,
  result: CreatedExecutionResult,
): FunctionExecutionRecord {
  const entry: FunctionExecutionEntry = {
    trigger: triggerName,
    cause: { ref, params },
    startedAt,
    durationMs,
    status: result.status,
  };
  if (result.status === 'fulfilled') entry.result = result.result;
  if (result.status === 'rejected') entry.error = describeError(result.error);
  return executionLogFor(ctx.sandbox).record(entry);
}

export default {
  tool: 'functions',
  method: 'fire',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'fire(trigger, path, value)',
  description:
    'Run a discovered trigger on a synthetic event built from path and value. Does not write value at path.',
  args: z.object({ trigger: triggerArgument, path: pathArgument, value: valueArgument }),
  operation: 'fire_functions_trigger',
  example: { trigger: 'makeUppercase', path: 'messages/abc123/original', value: 'hello' },
  async handler(args, ctx) {
    const triggerName = String(args.trigger);
    const path = String(args.path);
    const discovered = await discoverFunctionsTriggers(ctx.projectDir);
    const trigger = discovered.triggers.find((candidate) => candidate.exportName === triggerName);
    if (trigger === undefined) {
      return operationFailure(
        `functions.fire: '${triggerName}' does not name a discovered trigger. Call functions' listTriggers method to see the triggers this project defines.`,
      );
    }
    const params = matchRtdbReference(trigger.reference, path);
    if (params === null) {
      return operationFailure(
        `functions.fire: '${path}' does not match ${triggerName}'s reference pattern '${trigger.reference}'.`,
      );
    }
    const ref = normalizeRtdbReference(path);
    const startedAt = getClock(ctx.sandbox).now();
    const startedMonotonic = performance.now();
    const result = await executeOnValueCreated(
      trigger,
      { ref, params, value: args.value },
      eventOptionsFor(ctx, trigger),
    );
    const durationMs = performance.now() - startedMonotonic;
    const record = logExecution(ctx, triggerName, ref, params, startedAt, durationMs, result);
    if (result.status === 'rejected') {
      return operationFailure(`functions.fire: ${triggerName} threw: ${record.error}`, {
        executionId: record.id,
        event: result.event,
      });
    }
    return {
      ok: true,
      summary: `Ran ${triggerName} on a synthetic event at ${ref}; ${path} was not written.`,
      data: { executionId: record.id, event: result.event, result: result.result },
    };
  },
} satisfies MethodRecord;
