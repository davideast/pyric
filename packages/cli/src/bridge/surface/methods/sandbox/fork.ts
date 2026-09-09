/** Fork the live sandbox into a persisted branch. */
import { fork } from 'pyric/sandbox';
import { saveBranch } from 'pyric/sandbox/branches/store';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { z } from 'zod';

import { branchExists, branchName } from '../../arguments/branches.js';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'fork',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'fork(branch, candidateRules?)',
  description: 'Copy live into a branch, optionally under candidate rules.',
  args: z.object({
    branch: branchName,
    candidateRules: z
      .string()
      .optional()
      .describe(
        'Firestore rules source the branch runs under. The live sandbox keeps the rules it has.',
      ),
  }),
  operation: 'fork_sandbox_branch',
  renames: { name: 'branch', rules: 'candidateRules', firestoreRules: 'candidateRules' },
  example: { branch: 'draft' },
  async handler(args, ctx) {
    const name = String(args.branch);
    if (branchExists(ctx.projectDir, name)) {
      return operationFailure(
        `The project already holds a branch named '${name}'. Discard it, or fork under another name.`,
      );
    }
    const candidate = args.candidateRules;
    const rules =
      typeof candidate === 'string' ? candidate : getInternalEnv(ctx.sandbox).getRules();
    const branch = fork(ctx.sandbox.snapshot(), rules);
    const manifest = saveBranch(ctx.projectDir, name, branch, { base: 'live' });
    branch.sandbox.dispose();
    return {
      ok: true,
      summary: `Forked branch '${name}' from the live sandbox.`,
      data: {
        branch: name,
        created: manifest.created,
        base: manifest.base,
        eventCount: manifest.eventCount,
        rules: typeof candidate === 'string' ? 'candidate' : 'live',
      },
    };
  },
} satisfies MethodRecord;
