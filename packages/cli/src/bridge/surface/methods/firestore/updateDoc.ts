/** Merge fields into an existing Firestore document. */
import { z } from 'zod';
import { checkDocumentPath, RENAMES } from '../../arguments/firestore.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'updateDoc',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'updateDoc(path, data)',
  description: 'Merge fields into an existing document.',
  args: z.object({
    path: z.string().describe('Document path, for example users/alice.'),
    data: z.record(z.unknown()).describe('The fields to merge.'),
  }),
  operation: 'update_firestore_document',
  renames: RENAMES,
  example: { path: 'users/alice', data: { role: 'editor' } },
  validate: (args, { fail }) => checkDocumentPath('updateDoc', args, fail),
  async handler(args, ctx) {
    return callSandboxTool(ctx, 'firestore_update_document', {
      path: args.path,
      data: args.data,
    });
  },
} satisfies MethodRecord;
