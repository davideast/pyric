/**
 * Report what a branch holds that its reference does not, service by service.
 *
 * A branch carries every service, so a flat list of paths would leave a reader
 * to guess whether `docs/hello.txt` is a Storage object or a Firestore
 * document. Every divergence names its service, the summary counts them per
 * service, and the data groups them the same way, so "what would landing this
 * change do" is answerable without reading every record.
 *
 * The reference is the live sandbox by default. It can also be a checkpoint,
 * read through the same module `sandbox.checkpoint` writes with, so there is
 * one definition of what a checkpoint is. This method never creates one, so a
 * name with no checkpoint behind it is refused with the names that do have one
 * rather than compared against nothing.
 */
import { diff, type BranchDivergence } from 'pyric/sandbox';
import { loadBranch } from 'pyric/sandbox/branches/store';
import { z } from 'zod';

import { AGAINST_LIVE, branchName, refuseUnknownBranch } from '../../arguments/sandbox.js';
import { checkpointNames, readCheckpoint } from '../../checkpoints.js';
import { operationFailure } from '../../context.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';
import type { OperationResult } from '../../types.js';

export default {
  tool: 'sandbox',
  method: 'diff',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'diff(branch, against?: live|<checkpoint name>)',
  description: "Report a branch's divergences.",
  args: z.object({
    branch: branchName,
    against: z
      .string()
      .optional()
      .describe(`The reference to compare against: ${AGAINST_LIVE}, or a checkpoint name.`),
  }),
  operation: 'diff_sandbox_branch',
  renames: { target: 'against', reference: 'against', checkpoint: 'against' },
  example: { branch: 'draft' },
  async handler(args, ctx) {
    const name = String(args.branch);
    const loaded = await loadBranch(ctx.projectDir, name);
    if (loaded === null) {
      return refuseUnknownBranch(ctx.projectDir, name, failFor('sandbox', 'diff'));
    }
    const against = args.against === undefined ? AGAINST_LIVE : String(args.against);
    if (against === AGAINST_LIVE) {
      const divergences = await diff(loaded.branch, ctx.sandbox);
      loaded.branch.sandbox.dispose();
      return report(name, AGAINST_LIVE, divergences);
    }

    const checkpoint = await readCheckpoint(ctx.projectDir, against);
    if (checkpoint === null) {
      loaded.branch.sandbox.dispose();
      return refuseMissingCheckpoint(ctx.projectDir, against);
    }
    const divergences = await diff(loaded.branch, checkpoint.state);
    loaded.branch.sandbox.dispose();
    return report(name, against, divergences);
  },
} satisfies MethodRecord;

/** How many divergences each service accounts for, services with none omitted. */
function countsByService(divergences: readonly BranchDivergence[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const divergence of divergences) {
    counts[divergence.service] = (counts[divergence.service] ?? 0) + 1;
  }
  return counts;
}

/** The divergences of each service, under the service's name. */
function groupByService(
  divergences: readonly BranchDivergence[],
): Record<string, BranchDivergence[]> {
  const grouped: Record<string, BranchDivergence[]> = {};
  for (const divergence of divergences) {
    const held = grouped[divergence.service] ?? [];
    held.push(divergence);
    grouped[divergence.service] = held;
  }
  return grouped;
}

/** The per-service tail of the summary, such as `firestore 2, auth 1`. */
function countsSentence(counts: Record<string, number>): string {
  const named = Object.entries(counts).map(([service, count]) => `${service} ${count}`);
  if (named.length === 0) return '';
  return ` (${named.join(', ')})`;
}

/** The result shape both comparisons return. */
function report(
  branch: string,
  against: string,
  divergences: readonly BranchDivergence[],
): OperationResult {
  const counts = countsByService(divergences);
  const noun = divergences.length === 1 ? 'divergence' : 'divergences';
  return {
    ok: true,
    summary: `Branch '${branch}' has ${divergences.length} ${noun} from ${against}${countsSentence(counts)}.`,
    data: {
      branch,
      against,
      counts,
      byService: groupByService(divergences),
      divergences,
    },
  };
}

/** Refuse a checkpoint name nothing answers to, naming the ones that exist. */
async function refuseMissingCheckpoint(
  projectDir: string,
  against: string,
): Promise<OperationResult> {
  const known = await checkpointNames(projectDir);
  if (known.length === 0) {
    return operationFailure(
      `No checkpoint named '${against}'. The project holds no checkpoints, so the only reference is ${AGAINST_LIVE}.`,
    );
  }
  return operationFailure(
    `No checkpoint named '${against}'. The checkpoints the project holds are: ${known.join(', ')}.`,
  );
}
