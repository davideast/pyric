/**
 * Page through the sandbox's operation log.
 *
 * A cursor is an event id, so it means something only against the log that
 * handed it out. A restore or a reset replaces that log, and a cursor from
 * before it names no event. Starting from the top in that case reads like a
 * continuation and is not one, so a cursor the log does not carry is refused.
 */
import { z } from 'zod';
import { toListenerRecord, toOperationRecord, type OperationRecord } from 'pyric/sandbox';
import type { SandboxEvent } from 'pyric/sandbox';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

/** Methods the log carries that read state rather than change it. */
const READ_METHODS = new Set(['get', 'list', 'query', 'read', 'download', 'listen']);

function isWrite(record: OperationRecord): boolean {
  return !READ_METHODS.has(record.method);
}

function matchesKind(record: OperationRecord, kind: string): boolean {
  if (kind === 'all') return true;
  if (kind === 'denials') return record.result === 'deny';
  return isWrite(record);
}

/**
 * The record one event contributes to the requested page, or `null` when the
 * event belongs to a different page. `listeners` reads the lifecycle stream
 * (attach, detach, delivery, suppressed, errored) and nothing else; every
 * other kind reads the operation stream, where lifecycle never appeared.
 */
function recordForKind(event: SandboxEvent, kind: string): OperationRecord | null {
  if (kind === 'listeners') return toListenerRecord(event);
  const record = toOperationRecord(event);
  if (record === null) return null;
  if (!matchesKind(record, kind)) return null;
  return record;
}

export default {
  tool: 'sandbox',
  method: 'events',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'events(since?, limit?, kind?: all|denials|writes|listeners)',
  description: 'Page the operation log; since is a prior nextCursor.',
  args: z.object({
    since: z.string().optional().describe('The nextCursor a prior call returned.'),
    limit: z.number().int().positive().max(500).optional().describe('Default 50, maximum 500.'),
    kind: z.enum(['all', 'denials', 'writes', 'listeners']).optional(),
  }),
  operation: 'list_sandbox_events',
  example: { limit: 20, kind: 'denials' },
  async handler(args, ctx) {
    const since = typeof args.since === 'string' ? args.since : undefined;
    const limit = typeof args.limit === 'number' ? Math.min(args.limit, 500) : 50;
    const kind = typeof args.kind === 'string' ? args.kind : 'all';

    const history = ctx.sandbox.history();
    let startIndex = 0;
    if (since !== undefined) {
      const at = history.findIndex((event) => event.id === since);
      if (at === -1) {
        return operationFailure(
          `The operation log carries no event '${since}'. Either the log was replaced, by a restore or a reset, or the cursor is not one this sandbox handed out. Call events without 'since' to read the log the sandbox holds now.`,
        );
      }
      startIndex = at + 1;
    }

    const events: OperationRecord[] = [];
    let lastIndex = startIndex - 1;
    for (let i = startIndex; i < history.length && events.length < limit; i++) {
      lastIndex = i;
      const record = recordForKind(history[i]!, kind);
      if (record === null) continue;
      events.push(record);
    }
    const hasMore = lastIndex < history.length - 1;
    const nextCursor = hasMore ? history[lastIndex]!.id : null;

    return {
      ok: true,
      summary: `${events.length} event(s).`,
      data: { events, nextCursor },
    };
  },
} satisfies MethodRecord;
