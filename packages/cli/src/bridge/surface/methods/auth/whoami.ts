/** Report the agent identity and the app session, and which one runs next. */
import { z } from 'zod';
import { describeBothIdentities } from '../../held-identity.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'whoami',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'whoami()',
  description: 'Report the agent identity, the app session, and which one runs next.',
  args: z.object({}),
  operation: 'get_auth_identity',
  example: {},
  async handler(_args, ctx) {
    return describeBothIdentities(ctx);
  },
} satisfies MethodRecord;
