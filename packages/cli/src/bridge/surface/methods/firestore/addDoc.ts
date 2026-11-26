/** Add a Firestore document under a generated id. */
import { z } from 'zod';
import {
  checkCollectionPath,
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
  method: 'addDoc',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'addDoc(path, data, database?)',
  description:
    'Add a document to a collection under a generated id (accepts JSON sentinels).',
  args: z.object({
    path: z.string().describe('Collection path, for example users.'),
    data: z.record(z.string(), z.unknown()).describe('The document fields to write.'),
    database: databaseArgument,
  }),
  operation: 'add_firestore_document',
  renames: RENAMES,
  example: { path: 'users', data: { email: 'alice@example.com' } },
  validate(args, { fail }) {
    const dbCheck = checkFirestoreDatabase(args, fail);
    if (dbCheck !== null) return dbCheck;
    const path = checkCollectionPath('addDoc', args, fail);
    if (path !== null) return path;
    return checkFieldValues('addDoc', args, fail);
  },
  async handler(args, ctx) {
    const selector = firestoreDatabaseSelector(args.database);
    return callFirestoreSandboxTool(
      ctx,
      'firestore_add_document',
      {
        collection: args.path,
        data: fieldValuesOf('addDoc', args.data),
      },
      selector,
    );
  },
} satisfies MethodRecord;
