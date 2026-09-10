/**
 * Land a branch on the live sandbox and remove it.
 *
 * `promote` is destructive: it lands the branch's changes over live's, and the
 * branch it promoted is gone afterwards. The shared effect enforcement in
 * `method-validation.ts` refuses the call unless `args.confirm === true`
 * before this handler runs, so an unconfirmed call leaves both the live
 * sandbox and the branch directory exactly as they were.
 *
 * Atomicity is the engine's. `promote` captures the target before its first
 * write and puts that capture back if any part of the landing throws, across
 * every service rather than Firestore alone, so this handler adds no rollback
 * of its own. What it owns is the branch directory: the branch is removed only
 * after the engine reports the whole promotion landed, so a failed promotion
 * is one a caller can read the reason for and run again.
 *
 * What lands is the delta between the state the branch forked from and the
 * state it holds now, so state live gained after the fork and the branch never
 * touched survives the promotion rather than being reverted by it.
 */
import { promote } from 'pyric/sandbox';
import { loadBranch, removeBranch } from 'pyric/sandbox/branches/store';
import { z } from 'zod';

import { branchName, refuseUnknownBranch } from '../../arguments/sandbox.js';
import { operationFailure } from '../../context.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'promote',
  sdkOrigin: 'pyric',
  effect: 'destructive',
  signature: 'promote(branch, confirm)',
  description: 'Land the branch on live, then delete it.',
  args: z.object({
    branch: branchName,
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. Promote overwrites live state and deletes the branch.'),
  }),
  operation: 'promote_sandbox_branch',
  renames: { confirmed: 'confirm', force: 'confirm', yes: 'confirm' },
  example: { branch: 'draft', confirm: true },
  async handler(args, ctx) {
    const name = String(args.branch);
    const loaded = await loadBranch(ctx.projectDir, name);
    if (loaded === null) {
      return refuseUnknownBranch(ctx.projectDir, name, failFor('sandbox', 'promote'));
    }
    try {
      await promote(loaded.branch, ctx.sandbox);
    } catch (error) {
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
