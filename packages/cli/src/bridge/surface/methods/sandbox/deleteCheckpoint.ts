/**
 * Remove one saved checkpoint.
 *
 * A `write` rather than a `destructive` method: what it discards is a copy the
 * sandbox was saved into, never the sandbox itself, so deleting a checkpoint
 * changes nothing a later call reads. Without it a project's checkpoints only
 * ever accumulate, and a name saved by mistake stays in every listing.
 */
import { z } from 'zod';
import { CHECKPOINT_NAME_PATTERN, checkpointNames, removeCheckpoint } from '../../checkpoints.js';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'deleteCheckpoint',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'deleteCheckpoint(name)',
  description: 'Delete one checkpoint. The sandbox is untouched.',
  args: z.object({
    name: z
      .string()
      .regex(CHECKPOINT_NAME_PATTERN, 'letters, digits, "_", and "-", 1 to 64 characters'),
  }),
  operation: 'delete_sandbox_checkpoint',
  renames: { checkpoint: 'name' },
  example: { name: 'before-migration' },
  async handler(args, ctx) {
    const name = String(args.name);
    const removed = await removeCheckpoint(ctx.projectDir, name);
    if (!removed) {
      const known = await checkpointNames(ctx.projectDir);
      const list = known.length === 0 ? 'none' : known.join(', ');
      return operationFailure(`No checkpoint named '${name}'. Known checkpoints: ${list}.`);
    }
    return {
      ok: true,
      summary: `Deleted checkpoint '${name}'. The sandbox is unchanged.`,
      data: { name },
    };
  },
} satisfies MethodRecord;
