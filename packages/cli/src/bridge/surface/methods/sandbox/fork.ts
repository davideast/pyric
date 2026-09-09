/**
 * Fork the live sandbox's Firestore documents into a persisted branch.
 *
 * A branch is Firestore. `fork` copies the live Firestore documents and the
 * Realtime Database tree the snapshot carries; Storage objects, auth users,
 * and the rules the live sandbox runs under are not branched, and the methods
 * that follow (`diff`, `promote`) read and land Firestore documents alone.
 */
import { fork } from 'pyric/sandbox';
import { saveBranch } from 'pyric/sandbox/branches/store';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { z } from 'zod';

import { branchExists, branchName } from '../../arguments/sandbox.js';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'fork',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'fork(branch, candidateRules?)',
  description: 'Copy the live Firestore documents into a branch.',
  args: z.object({
    branch: branchName,
    candidateRules: z
      .string()
      .optional()
      .describe(
        'Rules the branch evaluates its own writes under, as Firestore rules source or a Realtime Database rules.json body. They decide verdicts on the branch only: the live sandbox keeps the rules it has, and promote installs none.',
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
