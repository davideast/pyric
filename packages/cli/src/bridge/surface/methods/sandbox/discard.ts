/**
 * Drop a branch without landing it.
 *
 * The live sandbox is not touched, which is the whole point: a branch exists
 * so a change can be abandoned. It is a `write` rather than a `destructive`
 * method because the state it discards is the branch's own and never the
 * sandbox a task was seeded with.
 */
import { removeBranch } from 'pyric/sandbox/branches/store';
import { z } from 'zod';

import { branchExists, branchName, refuseUnknownBranch } from '../../arguments/sandbox.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'discard',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'discard(branch)',
  description: 'Delete a branch. Live is untouched.',
  args: z.object({ branch: branchName }),
  operation: 'discard_sandbox_branch',
  renames: { name: 'branch' },
  example: { branch: 'draft' },
  async handler(args, ctx) {
    const name = String(args.branch);
    if (!branchExists(ctx.projectDir, name)) {
      return refuseUnknownBranch(ctx.projectDir, name, failFor('sandbox', 'discard'));
    }
    removeBranch(ctx.projectDir, name);
    return {
      ok: true,
      summary: `Discarded branch '${name}'. The live sandbox is unchanged.`,
      data: { branch: name },
    };
  },
} satisfies MethodRecord;
