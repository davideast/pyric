/** Replace the live sandbox with a saved checkpoint. */
import { z } from 'zod';
import { applyCheckpoint, checkpointNames, readCheckpoint } from '../../checkpoints.js';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'restore',
  sdkOrigin: 'pyric',
  effect: 'destructive',
  signature: 'restore(name, confirm)',
  description: 'Replace the live sandbox with a named checkpoint.',
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
    const file = readCheckpoint(ctx.projectDir, name);
    if (file === null) {
      const known = checkpointNames(ctx.projectDir);
      const list = known.length === 0 ? 'none' : known.join(', ');
      return operationFailure(`No checkpoint named '${name}'. Known checkpoints: ${list}.`);
    }
    await applyCheckpoint(ctx.sandbox, file);
    return {
      ok: true,
      summary: `Restored checkpoint '${name}' (${file.counts.firestore} docs, ${file.counts.database} database entries, ${file.counts.storage} objects, ${file.counts.auth} users).`,
      data: { name, counts: file.counts },
    };
  },
} satisfies MethodRecord;
