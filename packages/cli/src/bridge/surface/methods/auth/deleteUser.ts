/** Remove one user from the sandbox auth pool. */
import { z } from 'zod';
import { RENAMES, uid } from '../../arguments/auth.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'deleteUser',
  sdkOrigin: 'firebase-admin',
  effect: 'write',
  signature: 'deleteUser(uid)',
  description: 'Remove one user from the pool.',
  args: z.object({ uid }),
  operation: 'delete_auth_user',
  renames: RENAMES,
  example: { uid: 'alice' },
  async handler(args, ctx) {
    return callSandboxTool(ctx, 'auth_delete_user', { uid: args.uid });
  },
} satisfies MethodRecord;
