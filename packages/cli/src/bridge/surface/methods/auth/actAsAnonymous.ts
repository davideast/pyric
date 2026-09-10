/** Run every later call unauthenticated. */
import { z } from 'zod';
import { switchHeldIdentity } from '../../held-identity.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'actAsAnonymous',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'actAsAnonymous()',
  description: 'Run every later call unauthenticated.',
  args: z.object({}),
  operation: 'switch_auth_identity',
  example: {},
  async handler(_args, ctx) {
    return switchHeldIdentity(ctx, { mode: 'anonymous' });
  },
} satisfies MethodRecord;
