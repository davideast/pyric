/** Read one Cloud Storage object's metadata. */
import { z } from 'zod';
import { getMetadata, ref } from 'pyric/storage';
import { pathArgument, RENAMES } from '../../arguments/storage.js';
import { storageFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'getMetadata',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'getMetadata(path)',
  description: 'Read one object size, content type, and custom metadata.',
  args: z.object({ path: pathArgument }),
  operation: 'get_storage_metadata',
  renames: RENAMES,
  example: { path: 'uploads/hello.txt' },
  async handler(args, ctx) {
    const path = String(args.path);
    const metadata = await getMetadata(ref(storageFor(ctx), path));
    return { ok: true, summary: `Read metadata for ${path}`, data: { metadata } };
  },
} satisfies MethodRecord;
