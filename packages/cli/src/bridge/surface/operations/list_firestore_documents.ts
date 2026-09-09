/** List the documents in a Firestore collection. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Collection path, for example users or users/alice/posts.'),
  limit: z.number().optional().describe('Return at most this many documents.'),
});

export default {
  verb: 'list',
  service: 'firestore',
  object: 'documents',
  description: 'List the documents in a Firestore collection under the held identity.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const call: Record<string, unknown> = { collection: input.path };
    if (input.limit !== undefined) call.limit = input.limit;
    return callSandboxTool(ctx, 'firestore_list_documents', call);
  },
} satisfies OperationRecord;
