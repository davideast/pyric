/** Merge child keys into the Realtime Database value at one path. */
import { z } from 'zod';
import { ref, update } from 'pyric/database';
import { checkPath, pathArgument, RENAMES } from '../../arguments/database.js';
import { databaseFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'database',
  method: 'update',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'update(path, values)',
  description: 'Merge child keys into the value at one path.',
  args: z.object({
    path: pathArgument,
    values: z
      .record(z.unknown())
      .describe('Child keys to merge into the path. Other children are left alone.'),
  }),
  operation: 'update_database_value',
  renames: { ...RENAMES, value: 'values' },
  example: { path: 'rooms/lobby', values: { topic: 'welcome' } },
  validate: (args, { fail }) => checkPath('update', args, fail),
  async handler(args, ctx) {
    const path = String(args.path);
    await update(ref(databaseFor(ctx), path), args.values as Record<string, unknown>);
    return { ok: true, summary: `Updated ${path}` };
  },
} satisfies MethodRecord;
