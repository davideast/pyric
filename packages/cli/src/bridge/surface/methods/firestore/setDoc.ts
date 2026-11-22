/** Write one Firestore document at an explicit path. */
import { z } from 'zod';
import { type SetOptions } from 'pyric/firestore';
import {
  checkDocumentPath,
  checkFieldValues,
  fieldValuesOf,
  RENAMES,
  setOptions,
} from '../../arguments/firestore.js';
import {
  callFirestoreSandboxTool,
  checkFirestoreDatabase,
  databaseArgument,
  firestoreDatabaseSelector,
} from '../../firestore-database.js';
import type { Args, MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'setDoc',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'setDoc(path, data, options?, database?)',
  description:
    'Write one document, replacing unless options.merge is true or options.mergeFields lists fields to merge. Values accept $serverTimestamp/$increment/$arrayUnion/$arrayRemove sentinels.',
  args: z.object({
    path: z.string().describe('Document path, for example users/alice.'),
    data: z.record(z.unknown()).describe('The document fields to write.'),
    options: setOptions,
    database: databaseArgument,
  }),
  operation: 'write_firestore_document',
  renames: RENAMES,
  example: { path: 'users/alice', data: { role: 'admin' }, options: { merge: true } },
  validate(args, { fail }) {
    const dbCheck = checkFirestoreDatabase(args, fail);
    if (dbCheck !== null) return dbCheck;
    const path = checkDocumentPath('setDoc', args, fail);
    if (path !== null) return path;
    return checkFieldValues('setDoc', args, fail);
  },
  async handler(args, ctx) {
    const options = (args.options ?? {}) as Args;
    const path = String(args.path);
    const selector = firestoreDatabaseSelector(args.database);
    const decodedData = fieldValuesOf('setDoc', args.data);
    const hasMerge = typeof options.merge === 'boolean';
    const hasMergeFields = Array.isArray(options.mergeFields);
    const toolArgs: Record<string, unknown> = { path, data: decodedData };
    if (hasMerge || hasMergeFields) {
      const sdkOptions: SetOptions = {};
      if (hasMerge) sdkOptions.merge = options.merge as boolean;
      if (hasMergeFields) sdkOptions.mergeFields = options.mergeFields as string[];
      toolArgs.options = sdkOptions;
    }
    return callFirestoreSandboxTool(ctx, 'firestore_create_document', toolArgs, selector);
  },
} satisfies MethodRecord;
