/** Delete one Firestore document. */
import { z } from 'zod';
import { checkDocumentPath, RENAMES } from '../../arguments/firestore.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'deleteDoc',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'deleteDoc(path)',
  description: 'Delete one document.',
  args: z.object({ path: z.string().describe('Document path, for example users/alice.') }),
  operation: 'delete_firestore_document',
  renames: RENAMES,
  example: { path: 'users/alice' },
  validate: (args, { fail }) => checkDocumentPath('deleteDoc', args, fail),
  async handler(args, ctx) {
    return callSandboxTool(ctx, 'firestore_delete_document', { path: args.path });
  },
} satisfies MethodRecord;
