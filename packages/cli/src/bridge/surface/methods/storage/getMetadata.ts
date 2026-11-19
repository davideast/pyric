/** Read one Cloud Storage object's metadata. */
import { z } from 'zod';
import { getMetadata, ref } from 'pyric/storage';
import { bucketArgument, checkBucket, pathArgument, RENAMES } from '../../arguments/storage.js';
import { onBucket, selectedStorageBucket, storageAtBucket } from '../../storage-bucket.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'getMetadata',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'getMetadata(path, bucket?)',
  description: 'Read one object size, content type, and custom metadata.',
  args: z.object({ path: pathArgument, bucket: bucketArgument }),
  operation: 'get_storage_metadata',
  renames: RENAMES,
  example: { path: 'uploads/hello.txt' },
  validate: (args, ctx) => checkBucket(args, ctx.fail),
  async handler(args, ctx) {
    const path = String(args.path);
    const selector = selectedStorageBucket(ctx, args.bucket);
    const metadata = await getMetadata(ref(storageAtBucket(ctx, selector), path));
    return {
      ok: true,
      summary: onBucket(`Read metadata for ${path}`, selector),
      data: { metadata },
    };
  },
} satisfies MethodRecord;
