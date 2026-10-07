/** Read one Security Rules standard library module. */
import { z } from 'zod';
import { RENAMES, service } from '../../arguments/rules.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'rules',
  method: 'getStdlib',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'getStdlib(module, service?)',
  description: 'Read one standard library module signature list. Pass service database for the RTDB builders.',
  args: z.object({
    module: z.string().describe('Module key from the listing, for example math or timestamp.'),
    service: service.optional(),
  }),
  operation: 'get_rules_stdlib',
  renames: RENAMES,
  example: { module: 'timestamp' },
  async handler(args, ctx) {
    if (args.service !== undefined) {
      return callSandboxTool(ctx, 'rules_stdlib_get', { service: args.service, key: args.module });
    }
    return callSandboxTool(ctx, 'firestore_rules_stdlib_get', { key: args.module });
  },
} satisfies MethodRecord;
