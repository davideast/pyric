/** Apply many Firestore writes in one call. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  writes: z
    .array(
      z.object({
        op: z.enum(['set', 'update', 'delete']).describe('What the write does.'),
        path: z.string().describe('Document path the write targets.'),
        data: z.record(z.unknown()).optional().describe('Fields for set and update; ignored for delete.'),
      }),
    )
    .describe('Writes applied in order; the run stops at the first failure.'),
});

export default {
  verb: 'batch',
  service: 'firestore',
  object: 'writes',
  description:
    'Apply many Firestore writes in one call, in order. The efficient way to seed or bulk-edit rather than one call per document.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    return callSandboxTool(ctx, 'firestore_batch_write', { operations: input.writes });
  },
} satisfies OperationRecord;
