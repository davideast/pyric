/** Read one user record from the sandbox auth pool. */
import { z } from 'zod';
import { RENAMES, uid } from '../../arguments/auth.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'getUser',
  sdkOrigin: 'firebase-admin',
  effect: 'read',
  signature: 'getUser(uid)',
  description: 'Read one user record.',
  args: z.object({ uid }),
  operation: 'get_auth_user',
  renames: RENAMES,
  example: { uid: 'alice' },
  async handler(args, ctx) {
    return callSandboxTool(ctx, 'auth_get_user', { uid: args.uid });
  },
} satisfies MethodRecord;
