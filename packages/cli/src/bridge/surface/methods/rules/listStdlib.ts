/** List every Security Rules standard library module. */
import { z } from 'zod';
import { RENAMES, service } from '../../arguments/rules.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'rules',
  method: 'listStdlib',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'listStdlib(service?)',
  description:
    'List every Security Rules standard library module, or the modules one service can use. The database modules are TypeScript builders that compile to RTDB rule expressions.',
  args: z.object({ service: service.optional() }),
  operation: 'list_rules_stdlib',
  renames: RENAMES,
  example: {},
  async handler(args, ctx) {
    if (args.service !== undefined) {
      return callSandboxTool(ctx, 'rules_stdlib_list', { service: args.service });
    }
    return callSandboxTool(ctx, 'firestore_rules_stdlib_list', {});
  },
} satisfies MethodRecord;
