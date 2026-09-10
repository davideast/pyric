/** Count the documents a query matches, computed by the server rather than by reading them. */
import { z } from 'zod';
import { getCountFromServer } from 'pyric/firestore';
import { checkQueryArgs, constraint, queryFrom, RENAMES } from '../../arguments/firestore.js';
import { firestoreFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'getCountFromServer',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'getCountFromServer(path, constraints?[asc|desc])',
  description: 'Count matching documents without reading them.',
  args: z.object({
    path: z.string().describe('Collection path, for example users.'),
    constraints: z
      .array(constraint)
      .optional()
      .describe('where, orderBy, and limit constraints narrowing what is counted.'),
  }),
  operation: 'count_firestore_documents',
  renames: RENAMES,
  example: {
    path: 'users',
    constraints: [{ type: 'where', field: 'role', op: '==', value: 'admin' }],
  },
  validate: (args, { fail }) => checkQueryArgs('getCountFromServer', args, fail),
  async handler(args, ctx) {
    const path = String(args.path);
    const db = firestoreFor(ctx);
    const target = queryFrom(db, path, args);
    const snapshot = await getCountFromServer(target);
    const count = snapshot.data().count;
    return {
      ok: true,
      summary: `${count} document(s) match ${path}.`,
      data: { count },
    };
  },
} satisfies MethodRecord;
