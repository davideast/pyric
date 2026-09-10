/** Read one Cloud Storage object back as base64-encoded bytes. */
import { z } from 'zod';
import { getBytes, ref } from 'pyric/storage';
import { pathArgument, RENAMES } from '../../arguments/storage.js';
import { encodeBase64, storageFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'getBytes',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'getBytes(path)',
  description: 'Read one object back as base64-encoded bytes.',
  args: z.object({ path: pathArgument }),
  operation: 'download_storage_file',
  renames: RENAMES,
  example: { path: 'uploads/hello.txt' },
  async handler(args, ctx) {
    const path = String(args.path);
    const bytes = await getBytes(ref(storageFor(ctx), path));
    return {
      ok: true,
      summary: `Downloaded ${path} (${bytes.byteLength} bytes)`,
      data: { path, size: bytes.byteLength, contentBase64: encodeBase64(bytes) },
    };
  },
} satisfies MethodRecord;
