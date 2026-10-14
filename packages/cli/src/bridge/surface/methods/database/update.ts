/** Merge child keys into the Realtime Database value at one path. */
import { z } from 'zod';
import { ref, update } from 'pyric/database';
import { checkReference, instanceArgument, pathArgument, RENAMES } from '../../arguments/database.js';
import { instanceSelector, onInstance } from '../../database-instance.js';
import { databaseFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'database',
  method: 'update',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'update(path, values, instance?)',
  description:
    'Merge child keys into the value at one path. A server timestamp is written as {".sv": "timestamp"}.',
  args: z.object({
    path: pathArgument,
    values: z
      .record(z.unknown())
      .describe('Child keys to merge into the path. Other children are left alone.'),
    instance: instanceArgument,
  }),
  operation: 'update_database_value',
  renames: { ...RENAMES, value: 'values' },
  example: { path: 'rooms/lobby', values: { topic: 'welcome' } },
  validate: (args, { fail }) => checkReference('update', args, fail),
  async handler(args, ctx) {
    const path = String(args.path);
    const selector = await instanceSelector(ctx, args.instance);
    await update(ref(databaseFor(ctx, selector), path), args.values as Record<string, unknown>);
    return { ok: true, summary: onInstance(`Updated ${path}`, selector) };
  },
} satisfies MethodRecord;
