/** Merge children into one Realtime Database path. */
import { z } from 'zod';
import { ref, update } from 'pyric/database';
import { databaseFor } from '../service-handles.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Root-relative path, for example rooms/lobby.'),
  value: z.record(z.unknown()).describe('Child keys to merge into the path. Other children are left alone.'),
});

export default {
  verb: 'update',
  service: 'database',
  object: 'value',
  description: 'Merge child keys into one Realtime Database path, leaving the other children alone.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    await update(ref(databaseFor(ctx), input.path), input.value);
    return { ok: true, summary: `Updated ${input.path}` };
  },
} satisfies OperationRecord;
