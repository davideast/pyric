/** Read one Security Rules standard library module. */
import { z } from 'zod';
import { RENAMES } from '../../arguments/rules.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'rules',
  method: 'getStdlib',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'getStdlib(module)',
  description: 'Read one standard library module signature list.',
  args: z.object({
    module: z.string().describe('Module key from the listing, for example math or timestamp.'),
  }),
  operation: 'get_rules_stdlib',
  renames: RENAMES,
  example: { module: 'timestamp' },
  async handler(args, ctx) {
    return callSandboxTool(ctx, 'firestore_rules_stdlib_get', { key: args.module });
  },
} satisfies MethodRecord;
