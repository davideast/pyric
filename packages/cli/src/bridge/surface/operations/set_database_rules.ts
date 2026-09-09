/** Install a Realtime Database ruleset into the running sandbox. */
import { z } from 'zod';
import type { RtdbRulesJson } from 'pyric/rules';
import { setRules } from 'pyric/sandbox/database';
import { operationFailure } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  rules: z.string().describe('Compiled rules.json source to install.'),
});

export default {
  verb: 'set',
  service: 'database',
  object: 'rules',
  description:
    'Install a Realtime Database ruleset into the running sandbox. The rules must be valid JSON; a parse error is reported instead of being installed.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    let ruleset: RtdbRulesJson;
    try {
      ruleset = JSON.parse(input.rules) as RtdbRulesJson;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return operationFailure(
        `Database rules did not parse: ${message}. Pass rules JSON that parses, then call set again.`,
      );
    }
    setRules(ctx.sandbox, ruleset);
    return { ok: true, summary: 'Database rules installed.' };
  },
} satisfies OperationRecord;
