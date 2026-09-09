/** Download one object from sandbox Cloud Storage. */
import { z } from 'zod';
import { getBytes, ref } from 'pyric/storage';
import { encodeBase64, storageFor } from '../service-handles.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Object path within the bucket.'),
});

export default {
  verb: 'download',
  service: 'storage',
  object: 'file',
  description: 'Download one object from sandbox Cloud Storage and return it base64-encoded.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const bytes = await getBytes(ref(storageFor(ctx), input.path));
    return {
      ok: true,
      summary: `Downloaded ${input.path} (${bytes.byteLength} bytes)`,
      data: { path: input.path, size: bytes.byteLength, contentBase64: encodeBase64(bytes) },
    };
  },
} satisfies OperationRecord;
