/** Delete one Firestore document. */
import { z } from 'zod';
import { checkDocumentPath, RENAMES } from '../../arguments/firestore.js';
import {
  callFirestoreSandboxTool,
  checkFirestoreDatabase,
  databaseArgument,
  firestoreDatabaseSelector,
} from '../../firestore-database.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'deleteDoc',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'deleteDoc(path, database?)',
  description: 'Delete one document.',
  args: z.object({
    path: z.string().describe('Document path, for example users/alice.'),
    database: databaseArgument,
  }),
  operation: 'delete_firestore_document',
  renames: RENAMES,
  example: { path: 'users/alice' },
  validate: (args, { fail }) =>
    checkFirestoreDatabase(args, fail) ?? checkDocumentPath('deleteDoc', args, fail),
  async handler(args, ctx) {
    const selector = firestoreDatabaseSelector(args.database);
    return callFirestoreSandboxTool(ctx, 'firestore_delete_document', { path: args.path }, selector);
  },
} satisfies MethodRecord;
