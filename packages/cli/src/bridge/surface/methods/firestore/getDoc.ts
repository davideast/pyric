/** Read one Firestore document by path under the held identity. */
import { z } from 'zod';
import { checkDocumentPath, RENAMES } from '../../arguments/firestore.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'getDoc',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'getDoc(path)',
  description: 'Read one document.',
  args: z.object({ path: z.string().describe('Document path, for example users/alice.') }),
  operation: 'get_firestore_document',
  renames: RENAMES,
  example: { path: 'users/alice' },
  validate: (args, { fail }) => checkDocumentPath('getDoc', args, fail),
  async handler(args, ctx) {
    return callSandboxTool(ctx, 'firestore_get_document', { path: args.path });
  },
} satisfies MethodRecord;
