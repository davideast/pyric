/**
 * Report every branch the project holds.
 *
 * Each entry carries what the manifest recorded plus how far the branch has
 * drifted from the live sandbox, because a listing that showed only names
 * would leave a caller one call short of knowing which branch matters. The
 * drift is counted per service, so a branch that changed only its rules reads
 * differently from one that changed a hundred documents. The count is computed
 * by rebuilding each branch in its own sandbox, so this method changes neither
 * the live sandbox nor any file.
 */
import { diff, type BranchDivergence } from 'pyric/sandbox';
import { listBranches, loadBranch, type BranchListing } from 'pyric/sandbox/branches/store';
import { z } from 'zod';

import type { MethodRecord } from '../../method-types.js';

/** One listing entry as a caller reads it: the format tag is a file concern. */
function withoutFormat(entry: BranchListing) {
  return {
    name: entry.name,
    created: entry.created,
    base: entry.base,
    eventCount: entry.eventCount,
  };
}

/** How many divergences each service accounts for, services with none omitted. */
function countsByService(divergences: readonly BranchDivergence[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const divergence of divergences) {
    counts[divergence.service] = (counts[divergence.service] ?? 0) + 1;
  }
  return counts;
}

export default {
  tool: 'sandbox',
  method: 'listBranches',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'listBranches()',
  description: 'List branches.',
  args: z.object({}),
  operation: 'list_sandbox_branches',
  example: {},
  async handler(_args, ctx) {
    const branches = [];
    for (const entry of listBranches(ctx.projectDir)) {
      const loaded = await loadBranch(ctx.projectDir, entry.name);
      if (loaded === null) {
        branches.push({ ...withoutFormat(entry), divergences: 0, counts: {} });
        continue;
      }
      const divergences = await diff(loaded.branch, ctx.sandbox);
      loaded.branch.sandbox.dispose();
      branches.push({
        ...withoutFormat(entry),
        divergences: divergences.length,
        counts: countsByService(divergences),
      });
    }
    const noun = branches.length === 1 ? 'branch' : 'branches';
    return {
      ok: true,
      summary: `The project holds ${branches.length} ${noun}.`,
      data: { branches },
    };
  },
} satisfies MethodRecord;
