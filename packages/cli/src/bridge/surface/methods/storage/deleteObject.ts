/** Delete one Cloud Storage object. */
import { z } from 'zod';
import { deleteObject, ref } from 'pyric/storage';
import { bucketArgument, checkBucket, pathArgument, RENAMES } from '../../arguments/storage.js';
import { onBucket, selectedStorageBucket, storageAtBucket } from '../../storage-bucket.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'deleteObject',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'deleteObject(path, bucket?)',
  description: 'Delete one object.',
  args: z.object({ path: pathArgument, bucket: bucketArgument }),
  operation: 'delete_storage_file',
  renames: RENAMES,
  example: { path: 'uploads/hello.txt' },
  validate: (args, ctx) => checkBucket(args, ctx.fail),
  async handler(args, ctx) {
    const path = String(args.path);
    const selector = selectedStorageBucket(ctx, args.bucket);
    await deleteObject(ref(storageAtBucket(ctx, selector), path));
    return { ok: true, summary: onBucket(`Deleted ${path}`, selector) };
  },
} satisfies MethodRecord;
