/**
 * Commit several Firestore writes atomically as a batch.
 *
 * Every entry (`set`, `update`, `delete`, including `set` with `options.merge`
 * or `options.mergeFields`) runs through `firestore_batch_write` on one
 * `WriteBatch` commit, so a failure on any entry leaves no write behind.
 */
import { z } from 'zod';
import { type SetOptions } from 'pyric/firestore';
import {
  batchFieldValuesOf,
  checkBatch,
  checkBatchFieldValues,
  RENAMES,
  writeEntry,
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
  method: 'writeBatch',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'writeBatch(writes[{type: set|update|delete, path, data?, options?}], database?)',
  description:
    'Commit writes atomically as a batch; if any write fails, none are applied (accepts setDoc/updateDoc sentinels).',
  args: z.object({
    writes: z.array(writeEntry).describe('The writes, committed atomically in order.'),
    database: databaseArgument,
  }),
  operation: 'batch_firestore_writes',
  renames: RENAMES,
  example: {
    writes: [
      { type: 'set', path: 'users/alice', data: { role: 'admin' } },
      { type: 'delete', path: 'users/bob' },
    ],
  },
  validate(args, { fail }) {
    const dbCheck = checkFirestoreDatabase(args, fail);
    if (dbCheck !== null) return dbCheck;
    const shape = checkBatch(args, fail);
    if (shape !== null) return shape;
    return checkBatchFieldValues(args, fail);
  },
  async handler(args, ctx) {
    const writes = args.writes as Args[];
    const selector = firestoreDatabaseSelector(args.database);
    const operations = writes.map((write, index) => {
      const entry: Args = { op: write.type, path: write.path };
      if (write.data !== undefined) {
        entry.data = batchFieldValuesOf(index, write);
      }
      if (write.type === 'set' && write.options !== undefined) {
        const rawOptions = write.options as Args;
        const hasMerge = typeof rawOptions.merge === 'boolean';
        const hasMergeFields = Array.isArray(rawOptions.mergeFields);
        if (hasMerge || hasMergeFields) {
          const sdkOptions: SetOptions = {};
          if (hasMerge) sdkOptions.merge = rawOptions.merge as boolean;
          if (hasMergeFields) sdkOptions.mergeFields = rawOptions.mergeFields as string[];
          entry.options = sdkOptions;
        }
      }
      return entry;
    });
    return callFirestoreSandboxTool(ctx, 'firestore_batch_write', { operations }, selector);
  },
} satisfies MethodRecord;
