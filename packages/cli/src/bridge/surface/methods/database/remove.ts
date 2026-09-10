/** Delete the Realtime Database value at one path. */
import { z } from 'zod';
import { ref, remove } from 'pyric/database';
import { checkPath, pathArgument, RENAMES } from '../../arguments/database.js';
import { databaseFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'database',
  method: 'remove',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'remove(path)',
  description: 'Delete the value at one path.',
  args: z.object({ path: pathArgument }),
  operation: 'delete_database_value',
  renames: RENAMES,
  example: { path: 'rooms/lobby' },
  validate: (args, { fail }) => checkPath('remove', args, fail),
  async handler(args, ctx) {
    const path = String(args.path);
    await remove(ref(databaseFor(ctx), path));
    return { ok: true, summary: `Deleted ${path}` };
  },
} satisfies MethodRecord;
