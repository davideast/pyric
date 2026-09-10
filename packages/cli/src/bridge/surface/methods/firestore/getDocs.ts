/**
 * Read a Firestore collection, as a listing or as a query.
 *
 * One SDK method covers both, so the record reaches two canonical operations
 * and the constraint list decides which: with no where clause the read is the
 * listing the audit log records as `list_firestore_documents`, and with one it
 * is `query_firestore_documents`.
 */
import { z } from 'zod';
import {
  checkConstraints,
  collectionRead,
  constraint,
  constraintsOf,
  RENAMES,
} from '../../arguments/firestore.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';
import type { OperationResult } from '../../types.js';

/** Ordering descends by reversing the ascending result, which the data plane orders. */
function applyDirection(result: OperationResult, direction: string | undefined): OperationResult {
  if (direction !== 'desc' || !result.ok) return result;
  const payload = result.data as { docs?: unknown[] } | undefined;
  if (!payload?.docs) return result;
  return { ...result, data: { ...payload, docs: [...payload.docs].reverse() } };
}

export default {
  tool: 'firestore',
  method: 'getDocs',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'getDocs(path, constraints?[asc|desc])',
  description:
    'Read a collection. With no constraints this lists the collection; with constraints it runs a query.',
  args: z.object({
    path: z.string().describe('Collection path, for example users.'),
    constraints: z
      .array(constraint)
      .optional()
      .describe('where, orderBy, and limit constraints, applied in order.'),
  }),
  operation: {
    ids: ['list_firestore_documents', 'query_firestore_documents'],
    select: (args) =>
      constraintsOf(args).length === 0 ? 'list_firestore_documents' : 'query_firestore_documents',
  },
  renames: RENAMES,
  example: {
    path: 'users',
    constraints: [
      { type: 'where', field: 'role', op: '==', value: 'admin' },
      { type: 'limit', value: 10 },
    ],
  },
  validate: (args, { fail }) => checkConstraints(args, fail),
  async handler(args, ctx) {
    const read = collectionRead(args);
    const tool = read.filtered ? 'firestore_query_where' : 'firestore_list_documents';
    return applyDirection(await callSandboxTool(ctx, tool, read.call), read.direction);
  },
} satisfies MethodRecord;
