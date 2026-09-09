/**
 * Report what a branch holds that its reference does not.
 *
 * The reference is the live sandbox by default. It can also be a checkpoint,
 * which is a file another method writes; this method reads that file and never
 * creates one, so a name with no file behind it is refused with the names that
 * do have one rather than compared against nothing.
 */
import { diff } from 'pyric/sandbox';
import { loadBranch } from 'pyric/sandbox/branches/store';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import {
  AGAINST_LIVE,
  CHECKPOINT_STORE_RELATIVE,
  branchName,
  readCheckpointSnapshot,
  refuseUnknownBranch,
  storedCheckpointNames,
} from '../../arguments/branches.js';
import { operationFailure } from '../../context.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'diff',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'diff(branch, against)',
  description:
    'Report the documents a branch and its reference disagree on. The reference is the live sandbox, or a checkpoint by name.',
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

    const path = join(ctx.projectDir, CHECKPOINT_STORE_RELATIVE, `${against}.json`);
    if (!existsSync(path)) {
      loaded.branch.sandbox.dispose();
      return refuseMissingCheckpoint(ctx.projectDir, against);
    }
    const snapshot = readCheckpointSnapshot(path);
    if (snapshot === null) {
      loaded.branch.sandbox.dispose();
      return operationFailure(
        `The checkpoint file for '${against}' is not a sandbox snapshot this method can read.`,
      );
    }
    const divergences = diff(loaded.branch, snapshot);
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
  return {
    ok: true,
    summary: `Branch '${branch}' diverges from ${against} in ${divergences.length} places.`,
    data: { branch, against, divergences },
  };
}

/** Refuse a checkpoint name nothing on disk answers to, naming the ones that exist. */
function refuseMissingCheckpoint(projectDir: string, against: string) {
  const known = storedCheckpointNames(projectDir);
  if (known.length === 0) {
    return operationFailure(
      `No checkpoint named '${against}'. The project holds no checkpoints, so the only reference is ${AGAINST_LIVE}.`,
    );
  }
  return operationFailure(
    `No checkpoint named '${against}'. The checkpoints the project holds are: ${known.join(', ')}.`,
  );
}
