/** Enable Cloud Storage on the real project and link its default bucket. */
import { z } from 'zod';
import type { ProvisionStorageInput } from 'pyric/storage';
import { RENAMES } from '../../arguments/storage.js';
import { storageProvisionResult } from '../../storage-admin.js';
import type { Args, MethodRecord } from '../../method-types.js';
import type { OperationResult } from '../../types.js';

/** The provisioning input this call names, with an unnamed bucket left to the default. */
function inputFor(args: Args): ProvisionStorageInput {
  if (args.bucket === undefined) return {};
  return { bucketId: String(args.bucket) };
}

export default {
  tool: 'storage',
  method: 'provision',
  sdkOrigin: 'pyric',
  effect: 'production',
  signature: 'provision(bucket?, confirm)',
  description:
    'Enable Storage on the real project: the service, the default resource location, which is set once and cannot be changed, and the linked bucket.',
  args: z.object({
    bucket: z
      .string()
      .optional()
      .describe('Bucket id to create and link. Defaults to the project default bucket.'),
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. This call reaches Google with real credentials.'),
  }),
  operation: 'provision_storage_bucket',
  renames: RENAMES,
  example: { bucket: 'demo-project.firebasestorage.app', confirm: true },
  async handler(args): Promise<OperationResult> {
    return storageProvisionResult(inputFor(args));
  },
} satisfies MethodRecord;
