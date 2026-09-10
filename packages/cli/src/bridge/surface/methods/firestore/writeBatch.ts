/**
 * Apply several Firestore writes in order.
 *
 * The data plane has no separate merge flag on a batched write, so a `set` that
 * asks to merge is sent as an `update`, which is the write with merge
 * semantics there.
 */
import { z } from 'zod';
import {
  batchFieldValuesOf,
  checkBatch,
  checkBatchFieldValues,
  RENAMES,
  writeEntry,
} from '../../arguments/firestore.js';
import { callSandboxTool } from '../../context.js';
import type { Args, MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'writeBatch',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'writeBatch(writes[{type: set|update|delete, path, data?, options?}])',
  description:
    'Apply several writes in order, stopping at the first failure. Field values are written as JSON: {"$serverTimestamp": true}, {"$increment": <number>}, {"$arrayUnion": [...]}, {"$arrayRemove": [...]}, and {"$deleteField": true} in an update.',
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
    const operations = (args.writes as Args[]).map((write, index) => {
      const options = (write.options ?? {}) as Args;
      const merged = write.type === 'set' && options.merge === true;
      const entry: Args = { op: merged ? 'update' : write.type, path: write.path };
      if (write.data !== undefined) entry.data = batchFieldValuesOf(index, write);
      return entry;
    });
    return callSandboxTool(ctx, 'firestore_batch_write', { operations });
  },
} satisfies MethodRecord;
