/** Run every later call as the app's own signed-in user. */
import { z } from 'zod';
import { switchHeldIdentity } from '../../held-identity.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'useAppSession',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'useAppSession()',
  description: "Run every later call as the app's own signed-in user.",
  args: z.object({}),
  operation: 'switch_auth_identity',
  example: {},
  async handler(_args, ctx) {
    return switchHeldIdentity(ctx, { mode: 'app-session' });
  },
} satisfies MethodRecord;
