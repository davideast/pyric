/** Write one Firestore document at an explicit path. */
import { z } from 'zod';
import {
  checkDocumentPath,
  checkFieldValues,
  fieldValuesOf,
  RENAMES,
} from '../../arguments/firestore.js';
import { callSandboxTool } from '../../context.js';
import type { Args, MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'setDoc',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'setDoc(path, data, options?)',
  description:
    'Write one document, replacing it unless options.merge is true. Field values are written as JSON: {"$serverTimestamp": true}, {"$increment": <number>}, {"$arrayUnion": [...]}, {"$arrayRemove": [...]}.',
  args: z.object({
    path: z.string().describe('Document path, for example users/alice.'),
    data: z.record(z.unknown()).describe('The document fields to write.'),
    options: z
      .object({
        merge: z
          .boolean()
          .optional()
          .describe('Merge the fields into the existing document instead of replacing it.'),
      })
      .optional()
      .describe('Set options.'),
  }),
  operation: 'write_firestore_document',
  renames: RENAMES,
  example: { path: 'users/alice', data: { role: 'admin' }, options: { merge: true } },
  validate(args, { fail }) {
    const path = checkDocumentPath('setDoc', args, fail);
    if (path !== null) return path;
    return checkFieldValues('setDoc', args, fail);
  },
  async handler(args, ctx) {
    const options = (args.options ?? {}) as Args;
    const call = { path: args.path, data: fieldValuesOf('setDoc', args.data) };
    if (options.merge === true) return callSandboxTool(ctx, 'firestore_update_document', call);
    return callSandboxTool(ctx, 'firestore_create_document', call);
  },
} satisfies MethodRecord;
