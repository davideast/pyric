/**
 * Clear every service in the sandbox.
 *
 * `reset` takes an explicit confirmation. It clears every service at once, it
 * is one word away from `inspect` in an agent's vocabulary, and the state it
 * clears is the state a task was seeded with, so the cost of an accidental call
 * is the whole run.
 */
import { z } from 'zod';
import { quoted } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'reset',
  sdkOrigin: 'pyric',
  effect: 'destructive',
  signature: 'reset(confirm)',
  description: 'Clear every service. Requires confirm true.',
  args: z.object({
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. Reset clears documents, values, objects, and users.'),
  }),
  operation: 'reset_sandbox',
  renames: { confirmed: 'confirm', force: 'confirm', yes: 'confirm' },
  example: { confirm: true },
  validate: (args, { fail }) => {
    if (args.confirm === true) return null;
    return fail(
      `confirm is ${quoted(args.confirm)}. reset clears documents, database values, stored objects, and users in one call, so it takes an explicit confirmation.`,
      `Pass confirm: true.`,
      'confirm',
    );
  },
  async handler(_args, ctx) {
    const outcome = await ctx.sandbox.resetAll();
    if (outcome.errors.length > 0) {
      return {
        ok: false,
        summary: `Reset finished with ${outcome.errors.length} service errors.`,
        data: { errors: outcome.errors },
      };
    }
    return { ok: true, summary: 'Sandbox reset.', data: { errors: [] } };
  },
} satisfies MethodRecord;
