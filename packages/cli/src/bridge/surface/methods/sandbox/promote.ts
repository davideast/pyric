/**
 * Land a branch on the live sandbox and remove it.
 *
 * `promote` is destructive: it replaces live documents with the branch's, and
 * the branch it promoted is gone afterwards. The shared effect enforcement in
 * `method-validation.ts` refuses the call unless `args.confirm === true`
 * before this handler runs, so an unconfirmed call leaves both the live
 * sandbox and the branch directory exactly as they were.
 */
import { promote } from 'pyric/sandbox';
import { loadBranch, removeBranch } from 'pyric/sandbox/branches/store';
import { z } from 'zod';

import { branchName, refuseUnknownBranch } from '../../arguments/branches.js';
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
    promote(loaded.branch, ctx.sandbox);
    removeBranch(ctx.projectDir, name);
    return {
      ok: true,
      summary: `Promoted branch '${name}' onto the live sandbox and removed it.`,
      data: { branch: name, eventCount: loaded.manifest.eventCount },
    };
  },
} satisfies MethodRecord;
