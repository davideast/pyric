/** Add a Firestore document under a generated id. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Collection path the document is added under.'),
  data: z.record(z.unknown()).describe('The document fields to write.'),
});

export default {
  verb: 'add',
  service: 'firestore',
  object: 'document',
  description: 'Add a Firestore document under a generated id and return the minted path.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    return callSandboxTool(ctx, 'firestore_add_document', {
      collection: input.path,
      data: input.data,
    });
  },
} satisfies OperationRecord;
