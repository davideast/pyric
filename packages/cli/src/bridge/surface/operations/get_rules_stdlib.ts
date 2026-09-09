/** Read one Security Rules standard library module. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  module: z.string().describe('Module key from the stdlib listing, for example math or timestamp.'),
});

export default {
  verb: 'get',
  service: 'rules',
  object: 'stdlib',
  description:
    'Read one Security Rules standard library module: its purpose, every callable in it, signatures, and examples.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    return callSandboxTool(ctx, 'firestore_rules_stdlib_get', { key: input.module });
  },
} satisfies OperationRecord;
