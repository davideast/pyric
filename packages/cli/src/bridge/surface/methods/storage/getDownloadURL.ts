/** Mint the sandbox's download URL for one Cloud Storage object. */
import { z } from 'zod';
import { getDownloadURL, ref } from 'pyric/storage';
import { bucketArgument, checkBucket, pathArgument, RENAMES } from '../../arguments/storage.js';
import { onBucket, selectedStorageBucket, storageAtBucket } from '../../storage-bucket.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'getDownloadURL',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'getDownloadURL(path, bucket?)',
  description:
    "Mint the sandbox's download URL for one object: a data URI carrying its bytes, where production returns a token-signed HTTPS URL.",
  args: z.object({ path: pathArgument, bucket: bucketArgument }),
  operation: 'get_storage_download_url',
  renames: RENAMES,
  example: { path: 'uploads/hello.txt' },
  validate: (args, ctx) => checkBucket(args, ctx.fail),
  async handler(args, ctx) {
    const path = String(args.path);
    const selector = selectedStorageBucket(ctx, args.bucket);
    const url = await getDownloadURL(ref(storageAtBucket(ctx, selector), path));
    return {
      ok: true,
      summary: onBucket(`Minted a download URL for ${path}`, selector),
      data: { path, url },
    };
  },
} satisfies MethodRecord;
