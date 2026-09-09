/** Report what the sandbox holds. */
import { z } from 'zod';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'inspect',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'inspect()',
  description: 'Report loaded rules, document counts, and recent denials.',
  args: z.object({}),
  operation: 'inspect_sandbox',
  example: {},
  async handler(_args, ctx) {
    return callSandboxTool(ctx, 'sandbox_inspect', {});
  },
} satisfies MethodRecord;
