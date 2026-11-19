/** List the Cloud Storage objects under a folder. */
import { z } from 'zod';
import { listAll, ref } from 'pyric/storage';
import { bucketArgument, checkBucket, RENAMES } from '../../arguments/storage.js';
import { onBucket, selectedStorageBucket, storageAtBucket } from '../../storage-bucket.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'listAll',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'listAll(prefix?, bucket?)',
  description: 'List the objects under a folder, or under the bucket root.',
  args: z.object({
    prefix: z.string().optional().describe('Folder path to list under. Defaults to the root.'),
    bucket: bucketArgument,
  }),
  operation: 'list_storage_files',
  renames: RENAMES,
  example: { prefix: 'uploads' },
  validate: (args, ctx) => checkBucket(args, ctx.fail),
  async handler(args, ctx) {
    let prefix: string | undefined;
    if (args.prefix !== undefined) {
      prefix = String(args.prefix);
    }
    const selector = selectedStorageBucket(ctx, args.bucket);
    const targetPrefix = prefix ?? '';
    const listing = await listAll(ref(storageAtBucket(ctx, selector), targetPrefix));
    const items = listing.items.map((item) => item.fullPath);
    const prefixes = listing.prefixes.map((item) => item.fullPath);
    const displayPrefix = prefix ?? '/';
    return {
      ok: true,
      summary: onBucket(`${items.length} objects under ${displayPrefix}`, selector),
      data: { items, prefixes },
    };
  },
} satisfies MethodRecord;
