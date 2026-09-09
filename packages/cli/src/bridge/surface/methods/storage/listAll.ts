/** List the Cloud Storage objects under a folder. */
import { z } from 'zod';
import { listAll, ref } from 'pyric/storage';
import { RENAMES } from '../../arguments/storage.js';
import { storageFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'listAll',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'listAll(prefix?)',
  description: 'List the objects under a folder, or under the bucket root.',
  args: z.object({
    prefix: z.string().optional().describe('Folder path to list under. Defaults to the root.'),
  }),
  operation: 'list_storage_files',
  renames: RENAMES,
  example: { prefix: 'uploads' },
  async handler(args, ctx) {
    const prefix = args.prefix === undefined ? undefined : String(args.prefix);
    const listing = await listAll(ref(storageFor(ctx), prefix ?? ''));
    const items = listing.items.map((item) => item.fullPath);
    const prefixes = listing.prefixes.map((item) => item.fullPath);
    return {
      ok: true,
      summary: `${items.length} objects under ${prefix ?? '/'}`,
      data: { items, prefixes },
    };
  },
} satisfies MethodRecord;
