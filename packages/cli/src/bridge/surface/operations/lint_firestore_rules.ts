/** Lint a Firestore rules source. */
import { z } from 'zod';
import { callSandboxTool, operationFailure } from '../context.js';
import { activeFirestoreRules } from '../rules-simulation.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  rules: z.string().optional().describe('Rules source to lint. Defaults to the rules the sandbox is running.'),
});

export default {
  verb: 'lint',
  service: 'firestore',
  object: 'rules',
  description:
    'Lint a Firestore rules source for parse errors, unsupported constructs, budget violations, and permissive smells.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const source = input.rules ?? activeFirestoreRules(ctx);
    if (source.length === 0) {
      return operationFailure('No Firestore rules were supplied and none are loaded in the sandbox.');
    }
    return callSandboxTool(ctx, 'firestore_lint_rules', { source });
  },
} satisfies OperationRecord;
