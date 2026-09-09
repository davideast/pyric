/** Store one Cloud Storage object from a base64 payload. */
import { z } from 'zod';
import { ref, uploadBytes } from 'pyric/storage';
import {
  decodesAsBase64,
  metadata,
  pathArgument,
  RENAMES,
} from '../../arguments/storage.js';
import { decodeBase64, storageFor } from '../../service-handles.js';
import { quoted } from '../../closest-name.js';
import type { Args, MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'uploadBytes',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'uploadBytes(path, contentBase64, metadata?)',
  description: 'Store an object from base64-encoded bytes.',
  args: z.object({
    path: pathArgument,
    contentBase64: z.string().describe('Base64-encoded object payload.'),
    metadata,
  }),
  operation: 'upload_storage_file',
  renames: RENAMES,
  example: {
    path: 'uploads/hello.txt',
    contentBase64: 'aGVsbG8=',
    metadata: { contentType: 'text/plain', customMetadata: { owner: 'alice' } },
  },
  validate: (args, { fail }) => {
    const content = String(args.contentBase64);
    if (decodesAsBase64(content)) return null;
    const shown = content.length > 40 ? `${content.slice(0, 40)}...` : content;
    return fail(
      `contentBase64 ${quoted(shown)} is not base64. uploadBytes carries the object bytes base64 encoded, because a tool call is JSON.`,
      `Pass contentBase64 as the payload, base64 encoded.`,
      'contentBase64',
    );
  },
  async handler(args, ctx) {
    const path = String(args.path);
    const supplied = (args.metadata ?? {}) as Args;
    const settable: { contentType?: string; customMetadata?: Record<string, string> } = {};
    if (supplied.contentType !== undefined) settable.contentType = String(supplied.contentType);
    if (supplied.customMetadata !== undefined) {
      settable.customMetadata = supplied.customMetadata as Record<string, string>;
    }

    const bytes = decodeBase64(String(args.contentBase64));
    const result = await uploadBytes(ref(storageFor(ctx), path), bytes, settable);
    return {
      ok: true,
      summary: `Uploaded ${path} (${bytes.byteLength} bytes)`,
      data: {
        path,
        size: result.metadata.size,
        contentType: result.metadata.contentType,
      },
    };
  },
} satisfies MethodRecord;
