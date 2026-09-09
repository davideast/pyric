/** List every Security Rules standard library module. */
import { z } from 'zod';
import { RENAMES } from '../../arguments/rules.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'rules',
  method: 'listStdlib',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'listStdlib()',
  description: 'List every Security Rules standard library module.',
  args: z.object({}),
  operation: 'list_rules_stdlib',
  renames: RENAMES,
  example: {},
  async handler(_args, ctx) {
    return callSandboxTool(ctx, 'firestore_rules_stdlib_list', {});
  },
} satisfies MethodRecord;
