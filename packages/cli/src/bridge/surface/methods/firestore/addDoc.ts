/** Add a Firestore document under a generated id. */
import { z } from 'zod';
import {
  checkCollectionPath,
  checkFieldValues,
  fieldValuesOf,
  RENAMES,
} from '../../arguments/firestore.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'addDoc',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'addDoc(path, data)',
  description:
    'Add a document to a collection under a generated id. Field values are written as JSON: {"$serverTimestamp": true}, {"$increment": <number>}, {"$arrayUnion": [...]}, {"$arrayRemove": [...]}.',
  args: z.object({
    path: z.string().describe('Collection path, for example users.'),
    data: z.record(z.unknown()).describe('The document fields to write.'),
  }),
  operation: 'add_firestore_document',
  renames: RENAMES,
  example: { path: 'users', data: { email: 'alice@example.com' } },
  validate(args, { fail }) {
    const path = checkCollectionPath('addDoc', args, fail);
    if (path !== null) return path;
    return checkFieldValues('addDoc', args, fail);
  },
  async handler(args, ctx) {
    return callSandboxTool(ctx, 'firestore_add_document', {
      collection: args.path,
      data: fieldValuesOf('addDoc', args.data),
    });
  },
} satisfies MethodRecord;
