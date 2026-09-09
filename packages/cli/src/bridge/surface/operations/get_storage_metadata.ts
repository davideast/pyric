/** Read the stored metadata of one Cloud Storage object. */
import { z } from 'zod';
import { getMetadata, ref } from 'pyric/storage';
import { storageFor } from '../service-handles.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Object path within the bucket.'),
});

export default {
  verb: 'get',
  service: 'storage',
  object: 'metadata',
  description: 'Read size, content type, timestamps, and custom metadata for one Cloud Storage object.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const metadata = await getMetadata(ref(storageFor(ctx), input.path));
    return { ok: true, summary: `Read metadata for ${input.path}`, data: { metadata } };
  },
} satisfies OperationRecord;
