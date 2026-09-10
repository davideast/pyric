/** Replace the Realtime Database value at one path. */
import { z } from 'zod';
import { ref, set } from 'pyric/database';
import { checkPath, pathArgument, RENAMES } from '../../arguments/database.js';
import { databaseFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'database',
  method: 'set',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'set(path, value)',
  description:
    'Replace the value at one path. A server timestamp is written as {".sv": "timestamp"}.',
  args: z.object({
    path: pathArgument,
    value: z.unknown().describe('The value written at the path. Replaces whatever is there.'),
  }),
  operation: 'write_database_value',
  renames: RENAMES,
  example: { path: 'rooms/lobby', value: { name: 'Lobby' } },
  validate: (args, { fail }) => checkPath('set', args, fail),
  async handler(args, ctx) {
    const path = String(args.path);
    await set(ref(databaseFor(ctx), path), args.value);
    return { ok: true, summary: `Wrote ${path}` };
  },
} satisfies MethodRecord;
