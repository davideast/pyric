/** Replace the client-settable metadata on one Cloud Storage object. */
import { z } from 'zod';
import { ref, updateMetadata } from 'pyric/storage';
import {
  bucketArgument,
  checkBucket,
  pathArgument,
  RENAMES,
  settableMetadata,
} from '../../arguments/storage.js';
import { onBucket, selectedStorageBucket, storageAtBucket } from '../../storage-bucket.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'updateMetadata',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature:
    'updateMetadata(path, metadata{contentType, customMetadata, cacheControl, contentDisposition, contentEncoding, contentLanguage}, bucket?)',
  description:
    "Replace the client-settable metadata on one object, leaving its bytes alone. Custom metadata is replaced wholesale, and 'updated' follows the sandbox clock.",
  args: z.object({ path: pathArgument, metadata: settableMetadata, bucket: bucketArgument }),
  operation: 'update_storage_metadata',
  renames: RENAMES,
  example: {
    path: 'uploads/hello.txt',
    metadata: { cacheControl: 'max-age=300', customMetadata: { owner: 'alice' } },
  },
  validate: (args, ctx) => checkBucket(args, ctx.fail),
  async handler(args, ctx) {
    const path = String(args.path);
    const patch = settableMetadata.parse(args.metadata);
    const selector = selectedStorageBucket(ctx, args.bucket);
    const updated = await updateMetadata(ref(storageAtBucket(ctx, selector), path), patch);
    return {
      ok: true,
      summary: onBucket(`Updated the metadata on ${path}`, selector),
      data: { path, metadata: updated },
    };
  },
} satisfies MethodRecord;
