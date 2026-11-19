/** Read one Cloud Storage object back as base64-encoded bytes. */
import { z } from 'zod';
import { getBytes, ref } from 'pyric/storage';
import { bucketArgument, checkBucket, pathArgument, RENAMES } from '../../arguments/storage.js';
import { encodeBase64 } from '../../service-handles.js';
import { onBucket, selectedStorageBucket, storageAtBucket } from '../../storage-bucket.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'getBytes',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'getBytes(path, bucket?)',
  description: 'Read one object back as base64-encoded bytes.',
  args: z.object({ path: pathArgument, bucket: bucketArgument }),
  operation: 'download_storage_file',
  renames: RENAMES,
  example: { path: 'uploads/hello.txt' },
  validate: (args, ctx) => checkBucket(args, ctx.fail),
  async handler(args, ctx) {
    const path = String(args.path);
    const selector = selectedStorageBucket(ctx, args.bucket);
    const bytes = await getBytes(ref(storageAtBucket(ctx, selector), path));
    return {
      ok: true,
      summary: onBucket(`Downloaded ${path} (${bytes.byteLength} bytes)`, selector),
      data: { path, size: bytes.byteLength, contentBase64: encodeBase64(bytes) },
    };
  },
} satisfies MethodRecord;
