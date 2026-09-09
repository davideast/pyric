/** Delete one object from sandbox Cloud Storage. */
import { z } from 'zod';
import { deleteObject, ref } from 'pyric/storage';
import { storageFor } from '../service-handles.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  path: z.string().describe('Object path within the bucket.'),
});

export default {
  verb: 'delete',
  service: 'storage',
  object: 'file',
  description: 'Delete one object from sandbox Cloud Storage.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    await deleteObject(ref(storageFor(ctx), input.path));
    return { ok: true, summary: `Deleted ${input.path}` };
  },
} satisfies OperationRecord;
