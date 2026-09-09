/**
 * Report every branch the project holds.
 *
 * Each entry carries what the manifest recorded plus how far the branch has
 * drifted from the live sandbox, because a listing that showed only names
 * would leave a caller one call short of knowing which branch matters. The
 * drift count is computed by rebuilding each branch in its own sandbox, so
 * this method changes neither the live sandbox nor any file.
 */
import { diff } from 'pyric/sandbox';
import { listBranches, loadBranch } from 'pyric/sandbox/branches/store';
import { z } from 'zod';

import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'listBranches',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'listBranches()',
  description: 'List branches with fork time, event count, and drift.',
  args: z.object({}),
  operation: 'list_sandbox_branches',
  example: {},
  async handler(_args, ctx) {
    const branches = listBranches(ctx.projectDir).map((entry) => {
      const loaded = loadBranch(ctx.projectDir, entry.name);
      if (loaded === null) {
        return { ...withoutFormat(entry), divergences: 0 };
      }
      const divergences = diff(loaded.branch, ctx.sandbox).length;
      loaded.branch.sandbox.dispose();
      return { ...withoutFormat(entry), divergences };
    });
    const noun = branches.length === 1 ? 'branch' : 'branches';
    return {
      ok: true,
      summary: `The project holds ${branches.length} ${noun}.`,
      data: { branches },
    };
  },
} satisfies MethodRecord;

/** One listing entry as a caller reads it: the format tag is a file concern. */
function withoutFormat(entry: ReturnType<typeof listBranches>[number]) {
  return {
    name: entry.name,
    created: entry.created,
    base: entry.base,
    eventCount: entry.eventCount,
  };
}
