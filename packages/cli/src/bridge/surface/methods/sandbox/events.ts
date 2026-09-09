/** Page through the sandbox's operation log. */
import { z } from 'zod';
import { toOperationRecord, type OperationRecord } from 'pyric/sandbox';
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

export default {
  tool: 'sandbox',
  method: 'events',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'events(since?, limit?, kind?: all|denials|writes)',
  description: 'Page the operation log; since is a prior nextCursor.',
  args: z.object({
    since: z.string().optional().describe('The nextCursor a prior call returned.'),
    limit: z.number().int().positive().max(500).optional().describe('Default 50, maximum 500.'),
    kind: z.enum(['all', 'denials', 'writes']).optional(),
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
      if (at !== -1) startIndex = at + 1;
    }

    const events: OperationRecord[] = [];
    let lastIndex = startIndex - 1;
    for (let i = startIndex; i < history.length && events.length < limit; i++) {
      lastIndex = i;
      const record = toOperationRecord(history[i]!);
      if (record === null) continue;
      if (!matchesKind(record, kind)) continue;
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
