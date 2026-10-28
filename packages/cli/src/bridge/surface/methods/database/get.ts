/** Read the Realtime Database value at one path. */
import { z } from 'zod';
import { get, ref } from 'pyric/database';
import { checkReference, instanceArgument, pathArgument, RENAMES } from '../../arguments/database.js';
import { instanceSelector, onInstance } from '../../database-instance.js';
import { databaseFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'database',
  method: 'get',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'get(path, instance?)',
  description: 'Read the value at one path.',
  args: z.object({ path: pathArgument, instance: instanceArgument }),
  operation: 'get_database_value',
  renames: RENAMES,
  example: { path: 'rooms/lobby' },
  validate: (args, { fail }) => checkReference('get', args, fail),
  async handler(args, ctx) {
    const path = String(args.path);
    const selector = await instanceSelector(ctx, args.instance);
    const snapshot = await get(ref(databaseFor(ctx, selector), path));
    const value = snapshot.val();
    return {
      ok: true,
      summary: onInstance(value === null ? `No value at ${path}` : `Read ${path}`, selector),
      data: { exists: value !== null, value },
    };
  },
} satisfies MethodRecord;
