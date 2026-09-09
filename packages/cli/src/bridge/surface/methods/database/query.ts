/** Read the children of one Realtime Database path under an ordering and a filter. */
import { z } from 'zod';
import {
  equalTo,
  get,
  limitToFirst,
  orderByChild,
  query,
  ref,
  type QueryConstraint,
} from 'pyric/database';
import { checkPath, RENAMES } from '../../arguments/database.js';
import { databaseFor } from '../../service-handles.js';
import { quoted } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'database',
  method: 'query',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'query(path, orderByChild?, equalTo?, limitToFirst?)',
  description: 'Read the children of one path under an ordering, a filter, and a limit.',
  args: z.object({
    path: z.string().describe('Root-relative path whose children are queried.'),
    orderByChild: z.string().optional().describe('Child key the query orders and filters by.'),
    equalTo: z
      .union([z.string(), z.number(), z.boolean()])
      .optional()
      .describe('Keep only children whose ordered value equals this.'),
    limitToFirst: z
      .number()
      .optional()
      .describe('Return at most this many children from the start.'),
  }),
  operation: 'query_database_values',
  renames: RENAMES,
  example: { path: 'rooms', orderByChild: 'owner', equalTo: 'alice', limitToFirst: 10 },
  validate: (args, { fail }) => {
    const path = checkPath('query', args, fail);
    if (path !== null) return path;
    if (args.equalTo !== undefined && args.orderByChild === undefined) {
      return fail(
        `equalTo is ${quoted(args.equalTo)} with no orderByChild. The SDK filters only along an ordering.`,
        `Pass orderByChild naming the child key equalTo compares.`,
        'orderByChild',
      );
    }
    return null;
  },
  async handler(args, ctx) {
    const path = String(args.path);
    const constraints: QueryConstraint[] = [];
    if (args.orderByChild !== undefined) constraints.push(orderByChild(String(args.orderByChild)));
    if (args.equalTo !== undefined) constraints.push(equalTo(args.equalTo as string));
    if (args.limitToFirst !== undefined) constraints.push(limitToFirst(Number(args.limitToFirst)));

    const snapshot = await get(query(ref(databaseFor(ctx), path), ...constraints));
    const value = snapshot.val();
    const matches = value !== null && typeof value === 'object' ? Object.keys(value).length : 0;
    return { ok: true, summary: `${matches} children under ${path}`, data: { value } };
  },
} satisfies MethodRecord;
