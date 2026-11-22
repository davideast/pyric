/**
 * Read a Firestore collection, as a listing or as a query.
 *
 * One SDK method covers both, so the record reaches two canonical operations
 * and the constraint list decides which: with no where clause the read is the
 * listing the audit log records as `list_firestore_documents`, and with one it
 * is `query_firestore_documents`. Every `orderBy` constraint (with its
 * `direction`) is applied by the query engine before `limit`.
 */
import { z } from 'zod';
import {
  checkConstraints,
  constraint,
  constraintsOf,
  RENAMES,
} from '../../arguments/firestore.js';
import {
  callFirestoreSandboxTool,
  checkFirestoreDatabase,
  databaseArgument,
  firestoreDatabaseSelector,
} from '../../firestore-database.js';
import type { Args, MethodRecord } from '../../method-types.js';

interface OrderConstraintArg {
  field: string;
  direction?: 'asc' | 'desc';
}

function buildCollectionToolCall(args: Args): { tool: string; call: Args } {
  const entries = constraintsOf(args);
  const filters = entries
    .filter((entry) => entry.type === 'where')
    .map((entry) => ({ field: entry.field, op: entry.op, value: entry.value }));
  const orders: OrderConstraintArg[] = entries
    .filter((entry) => entry.type === 'orderBy')
    .map((entry) => {
      const clause: OrderConstraintArg = { field: String(entry.field) };
      if (entry.direction === 'asc' || entry.direction === 'desc') {
        clause.direction = entry.direction;
      }
      return clause;
    });
  const limits = entries
    .filter((entry) => entry.type === 'limit')
    .map((entry) => Number(entry.value));

  const call: Args = { collection: args.path };
  if (orders.length > 0) {
    call.orderBy = orders;
  }
  if (limits.length === 1) {
    call.limit = limits[0];
  } else if (limits.length > 1) {
    call.limits = limits;
  }
  if (filters.length > 0) {
    call.where = filters;
    return { tool: 'firestore_query_where', call };
  }
  return { tool: 'firestore_list_documents', call };
}

export default {
  tool: 'firestore',
  method: 'getDocs',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'getDocs(path, constraints?[asc|desc], database?)',
  description:
    'Read a collection. With no constraints this lists the collection; with constraints it runs a query.',
  args: z.object({
    path: z.string().describe('Collection path, for example users.'),
    constraints: z
      .array(constraint)
      .optional()
      .describe('where, orderBy, and limit constraints, applied in order.'),
    database: databaseArgument,
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
  validate: (args, { fail }) =>
    checkFirestoreDatabase(args, fail) ?? checkConstraints(args, fail),
  async handler(args, ctx) {
    const built = buildCollectionToolCall(args);
    const selector = firestoreDatabaseSelector(args.database);
    return callFirestoreSandboxTool(ctx, built.tool, built.call, selector);
  },
} satisfies MethodRecord;
