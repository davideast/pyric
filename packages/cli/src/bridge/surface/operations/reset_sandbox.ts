/** Clear every service in the sandbox. */
import { z } from 'zod';
import type { OperationRecord } from '../types.js';

const parameters = z.object({});

export default {
  verb: 'reset',
  service: 'sandbox',
  object: 'state',
  description: 'Clear every sandbox service: documents, database tree, stored objects, and the user pool.',
  parameters,
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
} satisfies OperationRecord;
