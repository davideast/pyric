/** List every saved checkpoint, newest first. */
import { z } from 'zod';
import { checkpointNames, readCheckpoint, type CheckpointCounts } from '../../checkpoints.js';
import type { MethodRecord } from '../../method-types.js';

interface CheckpointListing {
  name: string;
  at: number;
  counts: CheckpointCounts;
}

export default {
  tool: 'sandbox',
  method: 'listCheckpoints',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'listCheckpoints()',
  description: 'List checkpoints with save time and counts.',
  args: z.object({}),
  operation: 'list_sandbox_checkpoints',
  example: {},
  async handler(_args, ctx) {
    const checkpoints = checkpointNames(ctx.projectDir)
      .map((name) => {
        const file = readCheckpoint(ctx.projectDir, name);
        if (file === null) return null;
        return { name, at: file.at, counts: file.counts };
      })
      .filter((entry): entry is CheckpointListing => entry !== null)
      .sort((a, b) => b.at - a.at);
    return {
      ok: true,
      summary: `${checkpoints.length} checkpoint(s).`,
      data: { checkpoints },
    };
  },
} satisfies MethodRecord;
