/** Save the whole sandbox under a name, so a later call can restore it. */
import { z } from 'zod';
import { CHECKPOINT_NAME_PATTERN, writeCheckpoint } from '../../checkpoints.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'checkpoint',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'checkpoint(name)',
  description: 'Save the sandbox under a name.',
  args: z.object({
    name: z
      .string()
      .regex(CHECKPOINT_NAME_PATTERN, 'letters, digits, "_", and "-", 1 to 64 characters'),
  }),
  operation: 'checkpoint_sandbox',
  example: { name: 'before-migration' },
  async handler(args, ctx) {
    const name = String(args.name);
    const { overwrote, checkpoint } = await writeCheckpoint(ctx.sandbox, ctx.projectDir, name);
    const verb = overwrote ? 'Overwrote' : 'Saved';
    const counts = checkpoint.counts;
    return {
      ok: true,
      summary: `${verb} checkpoint '${name}' (${counts.firestore} docs, ${counts.database} database entries, ${counts.storage} objects, ${counts.auth} users).`,
      data: { name, overwrote, counts },
    };
  },
} satisfies MethodRecord;
