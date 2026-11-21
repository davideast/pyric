/**
 * Apply several Firestore writes in order.
 *
 * The data plane has no separate merge flag on a batched write, so a `set` that
 * asks to merge is sent as an `update`, which is the write with merge
 * semantics there.
 */
import { z } from 'zod';
import { deleteDoc, doc, setDoc, updateDoc, type SetOptions } from 'pyric/firestore';
import {
  batchFieldValuesOf,
  checkBatch,
  checkBatchFieldValues,
  RENAMES,
  writeEntry,
} from '../../arguments/firestore.js';
import { callSandboxTool } from '../../sandbox-context.js';
import { firestoreFor } from '../../service-handles.js';
import type { Args, MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'writeBatch',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'writeBatch(writes[{type: set|update|delete, path, data?, options?}])',
  description:
    'Apply writes in order, stopping at the first failure (accepts setDoc/updateDoc sentinels).',
  args: z.object({
    writes: z.array(writeEntry).describe('The writes, applied in order.'),
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
    const shape = checkBatch(args, fail);
    if (shape !== null) return shape;
    return checkBatchFieldValues(args, fail);
  },
  async handler(args, ctx) {
    const writes = args.writes as Args[];
    const hasMergeFields = writes.some((write) => {
      const options = (write.options ?? {}) as Args;
      return write.type === 'set' && Array.isArray(options.mergeFields);
    });
    if (!hasMergeFields) {
      const operations = writes.map((write, index) => {
        const options = (write.options ?? {}) as Args;
        const merged = write.type === 'set' && options.merge === true;
        let op = write.type;
        if (merged) {
          op = 'update';
        }
        const entry: Args = { op, path: write.path };
        if (write.data !== undefined) entry.data = batchFieldValuesOf(index, write);
        return entry;
      });
      return callSandboxTool(ctx, 'firestore_batch_write', { operations });
    }
    if (writes.length === 0 || writes.length > 500) {
      return {
        ok: false,
        summary: `firestore_batch_write: operations must be 1..500 (got ${writes.length}).`,
      };
    }
    const db = firestoreFor(ctx);
    for (const [index, write] of writes.entries()) {
      const target = doc(db, String(write.path));
      if (write.type === 'delete') {
        await deleteDoc(target);
        continue;
      }
      const data = batchFieldValuesOf(index, write) as Record<string, unknown>;
      if (write.type === 'update') {
        await updateDoc(target, data);
        continue;
      }
      const options = (write.options ?? {}) as Args;
      const sdkOptions: SetOptions = {};
      if (typeof options.merge === 'boolean') {
        sdkOptions.merge = options.merge;
      }
      if (Array.isArray(options.mergeFields)) {
        sdkOptions.mergeFields = options.mergeFields as string[];
      }
      await setDoc(target, data, sdkOptions);
    }
    return {
      ok: true,
      summary: `Applied ${writes.length} write(s)`,
      data: { count: writes.length },
    };
  },
} satisfies MethodRecord;
