/** Lint a Realtime Database ruleset. */
import { z } from 'zod';
import { rtdbRules } from 'pyric/rules';
import type { RtdbRulesJson } from 'pyric/rules';
import { getActiveRules } from 'pyric/sandbox/database';
import { operationFailure } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  rules: z
    .string()
    .optional()
    .describe('Compiled rules.json source. Defaults to the ruleset the sandbox is running.'),
});

function parseRuleset(source: string): RtdbRulesJson | null {
  try {
    return JSON.parse(source) as RtdbRulesJson;
  } catch {
    return null;
  }
}

export default {
  verb: 'lint',
  service: 'database',
  object: 'rules',
  description: 'Lint a Realtime Database ruleset for structural findings such as unguarded reads and writes.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    let ruleset: RtdbRulesJson | null = null;
    if (input.rules === undefined) {
      ruleset = getActiveRules(ctx.sandbox);
    } else {
      ruleset = parseRuleset(input.rules);
      if (ruleset === null) return operationFailure('The supplied database rules are not valid JSON.');
    }
    if (ruleset === null) {
      return operationFailure('No database rules were supplied and none are loaded in the sandbox.');
    }
    const issues = rtdbRules(ruleset).lint();
    const errors = issues.filter((issue) => issue.severity === 'error').length;
    return {
      ok: true,
      summary: `${issues.length} findings, ${errors} errors`,
      data: { issues },
    };
  },
} satisfies OperationRecord;
