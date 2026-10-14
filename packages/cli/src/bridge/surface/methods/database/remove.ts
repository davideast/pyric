/** Delete the Realtime Database value at one path. */
import { z } from 'zod';
import { ref, remove } from 'pyric/database';
import { checkReference, instanceArgument, pathArgument, RENAMES } from '../../arguments/database.js';
import { instanceSelector, onInstance } from '../../database-instance.js';
import { databaseFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'database',
  method: 'remove',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'remove(path, instance?)',
  description: 'Delete the value at one path.',
  args: z.object({ path: pathArgument, instance: instanceArgument }),
  operation: 'delete_database_value',
  renames: RENAMES,
  example: { path: 'rooms/lobby' },
  validate: (args, { fail }) => checkReference('remove', args, fail),
  async handler(args, ctx) {
    const path = String(args.path);
    const selector = await instanceSelector(ctx, args.instance);
    await remove(ref(databaseFor(ctx, selector), path));
    return { ok: true, summary: onInstance(`Deleted ${path}`, selector) };
  },
} satisfies MethodRecord;
