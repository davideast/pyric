/** Remove one Realtime Database path. */
import { z } from 'zod';
import { ref, remove } from 'pyric/database';
import { databaseFor } from '../service-handles.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Root-relative path, for example rooms/lobby.'),
});

export default {
  verb: 'delete',
  service: 'database',
  object: 'value',
  description: 'Remove the value and every child at one Realtime Database path.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    await remove(ref(databaseFor(ctx), input.path));
    return { ok: true, summary: `Deleted ${input.path}` };
  },
} satisfies OperationRecord;
