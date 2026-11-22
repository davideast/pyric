/** Merge fields into an existing Firestore document. */
import { z } from 'zod';
import {
  checkDocumentPath,
  checkFieldValues,
  fieldValuesOf,
  RENAMES,
} from '../../arguments/firestore.js';
import {
  callFirestoreSandboxTool,
  checkFirestoreDatabase,
  databaseArgument,
  firestoreDatabaseSelector,
} from '../../firestore-database.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'updateDoc',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'updateDoc(path, data, database?)',
  description:
    'Merge fields into an existing document (accepts $deleteField and JSON sentinels).',
  args: z.object({
    path: z.string().describe('Document path, for example users/alice.'),
    data: z.record(z.unknown()).describe('The fields to merge.'),
    database: databaseArgument,
  }),
  operation: 'update_firestore_document',
  renames: RENAMES,
  example: { path: 'users/alice', data: { role: 'editor' } },
  validate(args, { fail }) {
    const dbCheck = checkFirestoreDatabase(args, fail);
    if (dbCheck !== null) return dbCheck;
    const path = checkDocumentPath('updateDoc', args, fail);
    if (path !== null) return path;
    return checkFieldValues('updateDoc', args, fail);
  },
  async handler(args, ctx) {
    const selector = firestoreDatabaseSelector(args.database);
    return callFirestoreSandboxTool(
      ctx,
      'firestore_update_document',
      {
        path: args.path,
        data: fieldValuesOf('updateDoc', args.data),
      },
      selector,
    );
  },
} satisfies MethodRecord;
