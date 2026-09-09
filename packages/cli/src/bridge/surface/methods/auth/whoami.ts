/** Report the identity later calls run under. */
import { z } from 'zod';
import { describeHeldIdentity } from '../../held-identity.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'whoami',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'whoami()',
  description: 'Report the identity later calls run under.',
  args: z.object({}),
  operation: 'get_auth_identity',
  example: {},
  async handler(_args, ctx) {
    return describeHeldIdentity(ctx);
  },
} satisfies MethodRecord;
