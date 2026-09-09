/**
 * Land a branch on the live sandbox and remove it.
 *
 * `promote` is destructive: it replaces live documents with the branch's, and
 * the branch it promoted is gone afterwards. The shared effect enforcement in
 * `method-validation.ts` refuses the call unless `args.confirm === true`
 * before this handler runs, so an unconfirmed call leaves both the live
 * sandbox and the branch directory exactly as they were.
 *
 * The engine lands documents one at a time, so a write the live sandbox
 * refuses partway through would otherwise leave live half-landed with no way
 * back and the branch already deleted. This handler captures the live sandbox
 * first, in memory rather than as a checkpoint a caller can name, and puts
 * that capture back if any part of the landing throws. The branch is removed
 * only after the whole promotion is on live, so a failed promotion is one a
 * caller can read the reason for and run again.
 */
import { promote } from 'pyric/sandbox';
import { loadBranch, removeBranch } from 'pyric/sandbox/branches/store';
import { z } from 'zod';

import { branchName, refuseUnknownBranch } from '../../arguments/sandbox.js';
import { applyCheckpoint, captureCheckpoint } from '../../checkpoints.js';
import { operationFailure } from '../../context.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'promote',
  sdkOrigin: 'pyric',
  effect: 'destructive',
  signature: 'promote(branch, confirm)',
  description: "Replace live documents with the branch's, then delete it.",
  args: z.object({
    branch: branchName,
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. Promote overwrites live documents and deletes the branch.'),
  }),
  operation: 'promote_sandbox_branch',
  renames: { confirmed: 'confirm', force: 'confirm', yes: 'confirm' },
  example: { branch: 'draft', confirm: true },
  async handler(args, ctx) {
    const name = String(args.branch);
    const loaded = loadBranch(ctx.projectDir, name);
    if (loaded === null) {
      return refuseUnknownBranch(ctx.projectDir, name, failFor('sandbox', 'promote'));
    }
    const capture = await captureCheckpoint(ctx.sandbox);
    try {
      promote(loaded.branch, ctx.sandbox);
    } catch (error) {
      await applyCheckpoint(ctx.sandbox, capture);
      loaded.branch.sandbox.dispose();
      const reason = error instanceof Error ? error.message : String(error);
      return operationFailure(
        `Promoting branch '${name}' failed partway through: ${reason}. The live sandbox is back to what it held before the call, and the branch is still there to promote again.`,
      );
    }
    removeBranch(ctx.projectDir, name);
    return {
      ok: true,
      summary: `Promoted branch '${name}' onto the live sandbox and removed it.`,
      data: { branch: name, eventCount: loaded.manifest.eventCount },
    };
  },
} satisfies MethodRecord;
