/**
 * Remove one saved checkpoint.
 *
 * `destructive` under ADR-0014 Decision 5: a `write` is reversible by
 * checkpoint, and a checkpoint is the only copy of the state it holds, so
 * deleting one is the case the confirmation exists for. The shared effect
 * enforcement in `method-validation.ts` refuses the call unless
 * `args.confirm === true` before this record's own `handler` ever runs. The
 * sandbox itself is untouched: what the call discards is the saved state,
 * never the state a later read answers from.
 */
import { z } from 'zod';
import { CHECKPOINT_NAME_PATTERN, checkpointNames, removeCheckpoint } from '../../checkpoints.js';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'deleteCheckpoint',
  sdkOrigin: 'pyric',
  effect: 'destructive',
  signature: 'deleteCheckpoint(name, confirm)',
  description: 'Discard one checkpoint. The sandbox is untouched.',
  args: z.object({
    name: z
      .string()
      .regex(CHECKPOINT_NAME_PATTERN, 'letters, digits, "_", and "-", 1 to 64 characters'),
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. A checkpoint is the only copy of the state it holds.'),
  }),
  operation: 'delete_sandbox_checkpoint',
  renames: { checkpoint: 'name', confirmed: 'confirm', force: 'confirm', yes: 'confirm' },
  example: { name: 'before-migration', confirm: true },
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
      summary: `Discarded checkpoint '${name}'. The sandbox is unchanged.`,
      data: { name },
    };
  },
} satisfies MethodRecord;
