/** Query a Firestore collection with filters, ordering, and a limit. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord, OperationResult } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Collection path the query runs over.'),
  filters: z
    .array(
      z.object({
        field: z.string().describe('Field the clause compares.'),
        op: z
          .enum(['<', '<=', '==', '!=', '>=', '>', 'in', 'not-in', 'array-contains', 'array-contains-any'])
          .describe('Comparison operator.'),
        value: z.unknown().describe('Comparison value.'),
      }),
    )
    .optional()
    .describe('Where clauses, combined with AND.'),
  orderBy: z.string().optional().describe('Field to order the results by.'),
  direction: z.enum(['asc', 'desc']).optional().describe('Sort direction. Defaults to asc.'),
  limit: z.number().optional().describe('Return at most this many documents.'),
});

/** Ordering descends by reversing the ascending result, which the data plane orders. */
function applyDirection(result: OperationResult, direction: string | undefined): OperationResult {
  if (direction !== 'desc' || !result.ok) return result;
  const payload = result.data as { docs?: unknown[] } | undefined;
  if (!payload?.docs) return result;
  return { ...result, data: { ...payload, docs: [...payload.docs].reverse() } };
}

export default {
  verb: 'query',
  service: 'firestore',
  object: 'documents',
  description:
    'Query a Firestore collection with where clauses combined by AND, optional ordering, and a limit.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const call: Record<string, unknown> = { collection: input.path };
    if (input.orderBy !== undefined) call.orderBy = input.orderBy;
    if (input.limit !== undefined) call.limit = input.limit;

    if (input.filters === undefined || input.filters.length === 0) {
      const listed = await callSandboxTool(ctx, 'firestore_list_documents', call);
      return applyDirection(listed, input.direction);
    }
    call.where = input.filters;
    const matched = await callSandboxTool(ctx, 'firestore_query_where', call);
    return applyDirection(matched, input.direction);
  },
} satisfies OperationRecord;
