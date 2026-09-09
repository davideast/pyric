/** Replace the value at one Realtime Database path. */
import { z } from 'zod';
import { ref, set } from 'pyric/database';
import { databaseFor } from '../service-handles.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Root-relative path, for example rooms/lobby.'),
  value: z.unknown().describe('The value written at the path. Replaces whatever is there.'),
});

export default {
  verb: 'write',
  service: 'database',
  object: 'value',
  description: 'Replace the value at one Realtime Database path.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    await set(ref(databaseFor(ctx), input.path), input.value);
    return { ok: true, summary: `Wrote ${input.path}` };
  },
} satisfies OperationRecord;
