/** Read one Realtime Database path. */
import { z } from 'zod';
import { get, ref } from 'pyric/database';
import { databaseFor } from '../service-handles.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Root-relative path, for example rooms/lobby.'),
});

export default {
  verb: 'get',
  service: 'database',
  object: 'value',
  description: 'Read the value at one Realtime Database path under the held identity.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const snapshot = await get(ref(databaseFor(ctx), input.path));
    const value = snapshot.val();
    return {
      ok: true,
      summary: value === null ? `No value at ${input.path}` : `Read ${input.path}`,
      data: { exists: value !== null, value },
    };
  },
} satisfies OperationRecord;
