/** Remove one user from the sandbox auth pool. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  uid: z.string().describe('The user to remove.'),
});

export default {
  verb: 'delete',
  service: 'auth',
  object: 'user',
  description: 'Remove one user from the sandbox auth pool.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    return callSandboxTool(ctx, 'auth_delete_user', { uid: input.uid });
  },
} satisfies OperationRecord;
