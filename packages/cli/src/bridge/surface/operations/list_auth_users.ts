/** List the users in the sandbox auth pool. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  limit: z.number().optional().describe('Return at most this many users.'),
});

export default {
  verb: 'list',
  service: 'auth',
  object: 'users',
  description: 'List the users in the sandbox auth pool.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const call: Record<string, unknown> = {};
    if (input.limit !== undefined) call.limit = input.limit;
    return callSandboxTool(ctx, 'auth_list_users', call);
  },
} satisfies OperationRecord;
