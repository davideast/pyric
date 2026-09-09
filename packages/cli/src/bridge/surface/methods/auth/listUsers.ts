/** List the users in the sandbox auth pool. */
import { z } from 'zod';
import { RENAMES } from '../../arguments/auth.js';
import { callSandboxTool } from '../../context.js';
import type { Args, MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'listUsers',
  sdkOrigin: 'firebase-admin',
  effect: 'read',
  signature: 'listUsers(maxResults?)',
  description: 'List the users in the sandbox pool.',
  args: z.object({
    maxResults: z.number().optional().describe('Return at most this many users.'),
  }),
  operation: 'list_auth_users',
  renames: RENAMES,
  example: { maxResults: 20 },
  async handler(args, ctx) {
    const call: Args = {};
    if (args.maxResults !== undefined) call.limit = args.maxResults;
    return callSandboxTool(ctx, 'auth_list_users', call);
  },
} satisfies MethodRecord;
