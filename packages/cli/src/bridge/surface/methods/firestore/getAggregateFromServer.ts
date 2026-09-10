/** Compute count, sum, and average over a query on the server, in one round trip. */
import { z } from 'zod';
import { average, count, getAggregateFromServer, sum, type AggregateSpec } from 'pyric/firestore';
import {
  aggregateSpec,
  checkAggregateSpec,
  checkQueryArgs,
  constraint,
  queryFrom,
  RENAMES,
} from '../../arguments/firestore.js';
import { firestoreFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';
import type { InvalidArguments } from '../../method-types.js';

/** The sandbox aggregate spec built from `args.spec`'s requested keys. */
function chainSpecFrom(spec: { count?: boolean; sum?: string; average?: string }): AggregateSpec {
  const built: AggregateSpec = {};
  if (spec.count === true) built.count = count();
  if (typeof spec.sum === 'string') built.sum = sum(spec.sum);
  if (typeof spec.average === 'string') built.average = average(spec.average);
  return built;
}

export default {
  tool: 'firestore',
  method: 'getAggregateFromServer',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'getAggregateFromServer(path, spec{count?, sum?, average?}, constraints?[asc|desc])',
  description: 'Compute count, sum, average over a query.',
  args: z.object({
    path: z.string().describe('Collection path, for example orders.'),
    spec: aggregateSpec,
    constraints: z
      .array(constraint)
      .optional()
      .describe('where, orderBy, and limit constraints narrowing what is aggregated.'),
  }),
  operation: 'aggregate_firestore_documents',
  renames: RENAMES,
  example: {
    path: 'orders',
    spec: { count: true, sum: 'total', average: 'total' },
    constraints: [{ type: 'where', field: 'status', op: '==', value: 'paid' }],
  },
  validate: (args, { fail }): InvalidArguments | null => {
    const query = checkQueryArgs('getAggregateFromServer', args, fail);
    if (query !== null) return query;
    return checkAggregateSpec(args, fail);
  },
  async handler(args, ctx) {
    const path = String(args.path);
    const spec = args.spec as { count?: boolean; sum?: string; average?: string };
    const db = firestoreFor(ctx);
    const target = queryFrom(db, path, args);
    const snapshot = await getAggregateFromServer(target, chainSpecFrom(spec));
    const data = snapshot.data();
    const parts: string[] = [];
    if (spec.count === true) parts.push(`count ${data.count}`);
    if (typeof spec.sum === 'string') parts.push(`sum ${data.sum}`);
    if (typeof spec.average === 'string') parts.push(`average ${data.average}`);
    return {
      ok: true,
      summary: `${path}: ${parts.join(', ')}.`,
      data,
    };
  },
} satisfies MethodRecord;
