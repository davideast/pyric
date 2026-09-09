/** Write one Firestore document with set semantics. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Document path, for example users/alice.'),
  data: z.record(z.unknown()).describe('The document fields to write.'),
  merge: z
    .boolean()
    .optional()
    .describe('Merge the fields into an existing document instead of replacing it.'),
});

export default {
  verb: 'write',
  service: 'firestore',
  object: 'document',
  description:
    'Write one Firestore document at an explicit path. Replaces the document, or merges the supplied fields when merge is true.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const call = { path: input.path, data: input.data };
    if (input.merge === true) return callSandboxTool(ctx, 'firestore_update_document', call);
    return callSandboxTool(ctx, 'firestore_create_document', call);
  },
} satisfies OperationRecord;
