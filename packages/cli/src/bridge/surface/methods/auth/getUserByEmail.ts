/** Read one user record by its email address. */
import { z } from 'zod';
import { RENAMES } from '../../arguments/auth.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'getUserByEmail',
  sdkOrigin: 'firebase-admin',
  effect: 'read',
  signature: 'getUserByEmail(email)',
  description: 'Read one user record by address.',
  args: z.object({
    email: z.string().describe('The address on the account. Matched case-insensitively.'),
  }),
  operation: 'get_auth_user_by_email',
  renames: RENAMES,
  example: { email: 'alice@example.com' },
  async handler(args, ctx) {
    return callSandboxTool(ctx, 'auth_get_user', { email: args.email });
  },
} satisfies MethodRecord;
