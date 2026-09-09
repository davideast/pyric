/** Delete one Cloud Storage object. */
import { z } from 'zod';
import { deleteObject, ref } from 'pyric/storage';
import { pathArgument, RENAMES } from '../../arguments/storage.js';
import { storageFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'storage',
  method: 'deleteObject',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'deleteObject(path)',
  description: 'Delete one object.',
  args: z.object({ path: pathArgument }),
  operation: 'delete_storage_file',
  renames: RENAMES,
  example: { path: 'uploads/hello.txt' },
  async handler(args, ctx) {
    const path = String(args.path);
    await deleteObject(ref(storageFor(ctx), path));
    return { ok: true, summary: `Deleted ${path}` };
  },
} satisfies MethodRecord;
