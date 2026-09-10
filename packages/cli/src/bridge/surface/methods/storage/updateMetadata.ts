/** Replace the client-settable metadata on one Cloud Storage object. */
import { z } from 'zod';
import { ref, updateMetadata } from 'pyric/storage';
import { pathArgument, RENAMES, settableMetadata } from '../../arguments/storage.js';
import { storageFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'updateMetadata',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature:
    'updateMetadata(path, metadata{contentType, customMetadata, cacheControl, contentDisposition, contentEncoding, contentLanguage})',
  description:
    "Replace the client-settable metadata on one object, leaving its bytes alone. Custom metadata is replaced wholesale, and 'updated' follows the sandbox clock.",
  args: z.object({ path: pathArgument, metadata: settableMetadata }),
  operation: 'update_storage_metadata',
  renames: RENAMES,
  example: {
    path: 'uploads/hello.txt',
    metadata: { cacheControl: 'max-age=300', customMetadata: { owner: 'alice' } },
  },
  async handler(args, ctx) {
    const path = String(args.path);
    const patch = settableMetadata.parse(args.metadata);
    const updated = await updateMetadata(ref(storageFor(ctx), path), patch);
    return {
      ok: true,
      summary: `Updated the metadata on ${path}`,
      data: { path, metadata: updated },
    };
  },
} satisfies MethodRecord;
