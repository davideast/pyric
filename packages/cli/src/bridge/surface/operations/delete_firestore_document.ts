/** Delete one Firestore document. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Document path, for example users/alice.'),
});

export default {
  verb: 'delete',
  service: 'firestore',
  object: 'document',
  description: 'Delete one Firestore document.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    return callSandboxTool(ctx, 'firestore_delete_document', { path: input.path });
  },
} satisfies OperationRecord;
