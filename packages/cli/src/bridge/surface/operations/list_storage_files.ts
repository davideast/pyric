/** List the objects in sandbox Cloud Storage. */
import { z } from 'zod';
import { listAll, ref } from 'pyric/storage';
import { storageFor } from '../service-handles.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  prefix: z.string().optional().describe('Folder path to list under. Defaults to the bucket root.'),
});

export default {
  verb: 'list',
  service: 'storage',
  object: 'files',
  description: 'List the objects and folders stored under one Cloud Storage path.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const listing = await listAll(ref(storageFor(ctx), input.prefix ?? ''));
    const items = listing.items.map((item) => item.fullPath);
    const prefixes = listing.prefixes.map((item) => item.fullPath);
    return {
      ok: true,
      summary: `${items.length} objects under ${input.prefix ?? '/'}`,
      data: { items, prefixes },
    };
  },
} satisfies OperationRecord;
