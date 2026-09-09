/**
 * Clear every service in the sandbox.
 *
 * `reset` is destructive, so the shared effect enforcement in
 * `method-validation.ts` refuses the call unless `args.confirm === true`
 * before this record's own `handler` ever runs. It clears every service at
 * once, it is one word away from `inspect` in an agent's vocabulary, and the
 * state it clears is the state a task was seeded with, so the cost of an
 * accidental call is the whole run.
 */
import { z } from 'zod';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'reset',
  sdkOrigin: 'pyric',
  effect: 'destructive',
  signature: 'reset(confirm)',
  description: 'Discards every document, database value, stored object, and user in the sandbox.',
  args: z.object({
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. Reset clears documents, values, objects, and users.'),
  }),
  operation: 'reset_sandbox',
  renames: { confirmed: 'confirm', force: 'confirm', yes: 'confirm' },
  example: { confirm: true },
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
