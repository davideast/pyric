/**
 * Save the whole sandbox under a name, so a later call can restore it.
 *
 * Creating a fresh checkpoint is a reversible `write`; replacing an existing
 * checkpoint discards the only copy of the state that checkpoint held, so
 * overwriting requires `confirm: true` (ADR-0014 Decision 5).
 */
import { z } from 'zod';
import {
  CHECKPOINT_NAME_PATTERN,
  readCheckpoint,
  writeCheckpoint,
} from '../../checkpoints.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'checkpoint',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'checkpoint(name, confirm?)',
  description: 'Save state.',
  args: z.object({
    name: z
      .string()
      .regex(CHECKPOINT_NAME_PATTERN, 'letters, digits, "_", and "-", 1 to 64 characters'),
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true when overwriting an existing checkpoint.'),
  }),
  operation: 'checkpoint_sandbox',
  renames: { checkpoint: 'name', confirmed: 'confirm', force: 'confirm', yes: 'confirm' },
  example: { name: 'before-migration' },
  async handler(args, ctx) {
    const name = String(args.name);
    const existing = await readCheckpoint(ctx, name);
    if (existing !== null && args.confirm !== true) {
      const fail = failFor('sandbox', 'checkpoint');
      return fail(
        `checkpoint '${name}' already exists, and a checkpoint is the only copy of the state it holds.`,
        'Pass confirm: true to overwrite it, or choose another name.',
        'confirm',
      );
    }
    const { overwrote, checkpoint } = await writeCheckpoint(ctx.sandbox, ctx, name);
    const verb = overwrote ? 'Overwrote' : 'Saved';
    const counts = checkpoint.counts;
    return {
      ok: true,
      summary: `${verb} checkpoint '${name}' (${counts.firestore} docs, ${counts.database} database entries, ${counts.storage} objects, ${counts.auth} users).`,
      data: { name, overwrote, counts },
    };
  },
} satisfies MethodRecord;
