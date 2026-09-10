/** Replace the live sandbox with a saved checkpoint. */
import { z } from 'zod';
import { checkpointNames, restoreCheckpoint } from '../../checkpoints.js';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'restore',
  sdkOrigin: 'pyric',
  effect: 'destructive',
  signature: 'restore(name, confirm)',
  description: 'Replace live with a checkpoint.',
  args: z.object({
    name: z.string(),
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. Restore discards every change made since the checkpoint.'),
  }),
  operation: 'restore_sandbox',
  example: { name: 'before-migration', confirm: true },
  async handler(args, ctx) {
    const name = String(args.name);
    const restored = await restoreCheckpoint(ctx.sandbox, ctx.projectDir, name);
    if (restored === null) {
      const known = await checkpointNames(ctx.projectDir);
      const list = known.length === 0 ? 'none' : known.join(', ');
      return operationFailure(`No checkpoint named '${name}'. Known checkpoints: ${list}.`);
    }
    const counts = restored.counts;
    return {
      ok: true,
      summary: `Restored checkpoint '${name}' (${counts.firestore} docs, ${counts.database} database entries, ${counts.storage} objects, ${counts.auth} users).`,
      data: { name, counts },
    };
  },
} satisfies MethodRecord;
