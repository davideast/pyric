/** Read the Realtime Database value at one path. */
import { z } from 'zod';
import { get, ref } from 'pyric/database';
import { checkPath, pathArgument, RENAMES } from '../../arguments/database.js';
import { databaseFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'database',
  method: 'get',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'get(path)',
  description: 'Read the value at one path.',
  args: z.object({ path: pathArgument }),
  operation: 'get_database_value',
  renames: RENAMES,
  example: { path: 'rooms/lobby' },
  validate: (args, { fail }) => checkPath('get', args, fail),
  async handler(args, ctx) {
    const path = String(args.path);
    const snapshot = await get(ref(databaseFor(ctx), path));
    const value = snapshot.val();
    return {
      ok: true,
      summary: value === null ? `No value at ${path}` : `Read ${path}`,
      data: { exists: value !== null, value },
    };
  },
} satisfies MethodRecord;
