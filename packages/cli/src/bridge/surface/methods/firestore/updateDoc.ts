/** Merge fields into an existing Firestore document. */
import { z } from 'zod';
import {
  checkDocumentPath,
  checkFieldValues,
  fieldValuesOf,
  RENAMES,
} from '../../arguments/firestore.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'updateDoc',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'updateDoc(path, data)',
  description:
    'Merge fields into an existing document. Field values are written as JSON: {"$serverTimestamp": true}, {"$increment": <number>}, {"$arrayUnion": [...]}, {"$arrayRemove": [...]}, {"$deleteField": true}.',
  args: z.object({
    path: z.string().describe('Document path, for example users/alice.'),
    data: z.record(z.unknown()).describe('The fields to merge.'),
  }),
  operation: 'update_firestore_document',
  renames: RENAMES,
  example: { path: 'users/alice', data: { role: 'editor' } },
  validate(args, { fail }) {
    const path = checkDocumentPath('updateDoc', args, fail);
    if (path !== null) return path;
    return checkFieldValues('updateDoc', args, fail);
  },
  async handler(args, ctx) {
    return callSandboxTool(ctx, 'firestore_update_document', {
      path: args.path,
      data: fieldValuesOf('updateDoc', args.data),
    });
  },
} satisfies MethodRecord;
