/** Merge fields into an existing Firestore document. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Document path, for example users/alice.'),
  data: z.record(z.unknown()).describe('The fields to merge into the document.'),
});

export default {
  verb: 'update',
  service: 'firestore',
  object: 'document',
  description: 'Merge fields into an existing Firestore document.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    return callSandboxTool(ctx, 'firestore_update_document', {
      path: input.path,
      data: input.data,
    });
  },
} satisfies OperationRecord;
