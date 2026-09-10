/** Mint the sandbox's download URL for one Cloud Storage object. */
import { z } from 'zod';
import { getDownloadURL, ref } from 'pyric/storage';
import { pathArgument, RENAMES } from '../../arguments/storage.js';
import { storageFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'getDownloadURL',
  sdkOrigin: 'firebase-js',
  effect: 'read',
  signature: 'getDownloadURL(path)',
  description:
    "The sandbox's download URL for one object, which resolves only against this sandbox: it is a data URI carrying the object's own bytes, where production returns a token-signed HTTPS URL.",
  args: z.object({ path: pathArgument }),
  operation: 'get_storage_download_url',
  renames: RENAMES,
  example: { path: 'uploads/hello.txt' },
  async handler(args, ctx) {
    const path = String(args.path);
    const url = await getDownloadURL(ref(storageFor(ctx), path));
    return {
      ok: true,
      summary: `Minted a download URL for ${path}`,
      data: { path, url },
    };
  },
} satisfies MethodRecord;
