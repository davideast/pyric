/** Run every later call with rules bypassed. */
import { z } from 'zod';
import { switchHeldIdentity } from '../../held-identity.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'actAsAdmin',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'actAsAdmin()',
  description: 'Run every later call with rules bypassed.',
  args: z.object({}),
  operation: 'switch_auth_identity',
  example: {},
  async handler(_args, ctx) {
    return switchHeldIdentity(ctx, { mode: 'admin' });
  },
} satisfies MethodRecord;
