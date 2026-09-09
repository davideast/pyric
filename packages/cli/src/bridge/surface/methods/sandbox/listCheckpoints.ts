/** List every saved checkpoint, newest first. */
import { z } from 'zod';
import { listProjectCheckpoints } from '../../checkpoints.js';
import type { MethodRecord } from '../../method-types.js';

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
    const listed = await listProjectCheckpoints(ctx.projectDir);
    const checkpoints = [...listed].sort((a, b) => b.at - a.at);
    return {
      ok: true,
      summary: `${checkpoints.length} checkpoint(s).`,
      data: { checkpoints },
    };
  },
} satisfies MethodRecord;
