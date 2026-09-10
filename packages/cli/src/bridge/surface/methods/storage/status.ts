/** Probe the real project's Cloud Storage service, buckets, and resource location. */
import { z } from 'zod';
import { storageStatusResult } from '../../storage-admin.js';
import type { MethodRecord } from '../../method-types.js';
import type { OperationResult } from '../../types.js';

export default {
  tool: 'storage',
  method: 'status',
  sdkOrigin: 'pyric',
  effect: 'production',
  signature: 'status(confirm)',
  description:
    "Read the real project's Storage service state, default resource location, and linked buckets.",
  args: z.object({
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. This call reaches Google with real credentials.'),
  }),
  operation: 'get_storage_service_status',
  example: { confirm: true },
  async handler(): Promise<OperationResult> {
    return storageStatusResult();
  },
} satisfies MethodRecord;
