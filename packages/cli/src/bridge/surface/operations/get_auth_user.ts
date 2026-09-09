/** Read one user record from the sandbox auth pool. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  uid: z.string().describe('The user to read.'),
});

export default {
  verb: 'get',
  service: 'auth',
  object: 'user',
  description: 'Read one user record from the sandbox auth pool by uid.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    return callSandboxTool(ctx, 'auth_get_user', { uid: input.uid });
  },
} satisfies OperationRecord;
