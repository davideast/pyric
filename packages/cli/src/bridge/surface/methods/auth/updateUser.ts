/** Change one user record in the sandbox auth pool. */
import { z } from 'zod';
import { checkCredentials, RENAMES, uid } from '../../arguments/auth.js';
import { callSandboxTool } from '../../context.js';
import type { Args, MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'updateUser',
  sdkOrigin: 'firebase-admin',
  effect: 'write',
  signature: 'updateUser(uid, email?, password?, displayName?, disabled?, emailVerified?)',
  description: 'Change one user record.',
  args: z.object({
    uid,
    email: z.string().optional().describe('Replacement email address.'),
    password: z.string().optional().describe('Replacement password.'),
    displayName: z.string().optional().describe('Replacement display name.'),
    disabled: z.boolean().optional().describe('Whether the account is disabled.'),
    emailVerified: z.boolean().optional().describe('Whether the email is verified.'),
  }),
  operation: 'update_auth_user',
  renames: RENAMES,
  example: { uid: 'alice', displayName: 'Alice', emailVerified: true },
  validate: (args, { fail }) => checkCredentials(args, fail),
  async handler(args, ctx) {
    const call: Args = { uid: args.uid };
    for (const name of ['email', 'password', 'displayName', 'disabled', 'emailVerified']) {
      if (args[name] !== undefined) call[name] = args[name];
    }
    return callSandboxTool(ctx, 'auth_update_user', call);
  },
} satisfies MethodRecord;
