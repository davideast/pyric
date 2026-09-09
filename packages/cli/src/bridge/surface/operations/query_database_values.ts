/** Query the children of one Realtime Database path. */
import { z } from 'zod';
import { equalTo, get, limitToFirst, orderByChild, query, ref, type QueryConstraint } from 'pyric/database';
import { databaseFor } from '../service-handles.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Root-relative path whose children are queried.'),
  orderByChild: z.string().optional().describe('Child key the query orders and filters by.'),
  equalTo: z
    .union([z.string(), z.number(), z.boolean()])
    .optional()
    .describe('Keep only children whose ordered value equals this.'),
  limitToFirst: z.number().optional().describe('Return at most this many children from the start.'),
});

export default {
  verb: 'query',
  service: 'database',
  object: 'values',
  description:
    'Query the children of one Realtime Database path, ordered by a child key with an optional equality filter and limit.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const constraints: QueryConstraint[] = [];
    if (input.orderByChild !== undefined) constraints.push(orderByChild(input.orderByChild));
    if (input.equalTo !== undefined) constraints.push(equalTo(input.equalTo));
    if (input.limitToFirst !== undefined) constraints.push(limitToFirst(input.limitToFirst));

    const snapshot = await get(query(ref(databaseFor(ctx), input.path), ...constraints));
    const value = snapshot.val();
    const matches = value !== null && typeof value === 'object' ? Object.keys(value).length : 0;
    return { ok: true, summary: `${matches} children under ${input.path}`, data: { value } };
  },
} satisfies OperationRecord;
