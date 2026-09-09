/**
 * Report the Firestore documents a branch holds that its reference does not.
 *
 * The comparison is Firestore alone. Storage objects, auth users, and the
 * Realtime Database tree are never compared, because a branch does not carry a
 * separate copy of them to compare.
 *
 * The reference is the live sandbox by default. It can also be a checkpoint,
 * read through the same loader `sandbox.checkpoint` writes with, so there is
 * one definition of what a checkpoint file is. This method never creates one,
 * so a name with no file behind it is refused with the names that do have one
 * rather than compared against nothing.
 */
import { diff } from 'pyric/sandbox';
import { loadBranch } from 'pyric/sandbox/branches/store';
import { z } from 'zod';

import { AGAINST_LIVE, branchName, refuseUnknownBranch } from '../../arguments/sandbox.js';
import { checkpointNames, checkpointSnapshot, readCheckpoint } from '../../checkpoints.js';
import { operationFailure } from '../../context.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'diff',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'diff(branch, against?: live|<checkpoint name>)',
  description: 'Report the Firestore documents a branch and its reference differ on.',
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
    const loaded = loadBranch(ctx.projectDir, name);
    if (loaded === null) {
      return refuseUnknownBranch(ctx.projectDir, name, failFor('sandbox', 'diff'));
    }
    const against = args.against === undefined ? AGAINST_LIVE : String(args.against);
    if (against === AGAINST_LIVE) {
      const divergences = diff(loaded.branch, ctx.sandbox);
      loaded.branch.sandbox.dispose();
      return report(name, AGAINST_LIVE, divergences);
    }

    const file = readCheckpoint(ctx.projectDir, against);
    if (file === null) {
      loaded.branch.sandbox.dispose();
      return refuseMissingCheckpoint(ctx.projectDir, against);
    }
    const divergences = diff(loaded.branch, checkpointSnapshot(file));
    loaded.branch.sandbox.dispose();
    return report(name, against, divergences);
  },
} satisfies MethodRecord;

/** The result shape both comparisons return. */
function report(
  branch: string,
  against: string,
  divergences: ReturnType<typeof diff>,
): { ok: true; summary: string; data: unknown } {
  const noun = divergences.length === 1 ? 'divergence' : 'divergences';
  return {
    ok: true,
    summary: `Branch '${branch}' has ${divergences.length} ${noun} from ${against}.`,
    data: { branch, against, divergences },
  };
}

/** Refuse a checkpoint name nothing on disk answers to, naming the ones that exist. */
function refuseMissingCheckpoint(projectDir: string, against: string) {
  const known = checkpointNames(projectDir);
  if (known.length === 0) {
    return operationFailure(
      `No checkpoint named '${against}'. The project holds no checkpoints, so the only reference is ${AGAINST_LIVE}.`,
    );
  }
  return operationFailure(
    `No checkpoint named '${against}'. The checkpoints the project holds are: ${known.join(', ')}.`,
  );
}
