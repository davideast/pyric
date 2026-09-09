/** Upload one object to sandbox Cloud Storage. */
import { z } from 'zod';
import { ref, uploadBytes } from 'pyric/storage';
import { decodeBase64, storageFor } from '../service-handles.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Object path within the bucket, for example uploads/pic.png.'),
  contentBase64: z.string().describe('Base64-encoded object payload.'),
  contentType: z.string().optional().describe('MIME type stored with the object.'),
  metadata: z.record(z.string()).optional().describe('Custom metadata stored with the object.'),
});

export default {
  verb: 'upload',
  service: 'storage',
  object: 'file',
  description: 'Upload one object to sandbox Cloud Storage from a base64 payload.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const bytes = decodeBase64(input.contentBase64);
    const settable: { contentType?: string; customMetadata?: Record<string, string> } = {};
    if (input.contentType !== undefined) settable.contentType = input.contentType;
    if (input.metadata !== undefined) settable.customMetadata = input.metadata;

    const result = await uploadBytes(ref(storageFor(ctx), input.path), bytes, settable);
    return {
      ok: true,
      summary: `Uploaded ${input.path} (${bytes.byteLength} bytes)`,
      data: { path: input.path, size: result.metadata.size, contentType: result.metadata.contentType },
    };
  },
} satisfies OperationRecord;
