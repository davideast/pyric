/**
 * Fork the live sandbox into a persisted branch.
 *
 * The fork captures the whole live sandbox, not its Firestore documents: a
 * branch reads identically to live in every service, so an experiment that
 * uploads an object or creates an account starts from the state live actually
 * holds rather than from an empty one.
 *
 * `candidateRules` names the rule sources the branch runs under in place of
 * live's. A string is Firestore rules, which is the common case; an object
 * names each service, so a branch can try a Storage or Realtime Database
 * ruleset without touching the other two.
 */
import { captureFullState, fork, type BranchCandidateRules } from 'pyric/sandbox';
import { saveBranch } from 'pyric/sandbox/branches/store';
import { z } from 'zod';

import { branchExists, branchName, candidateRules } from '../../arguments/sandbox.js';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'fork',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'fork(branch, candidateRules?: string | {firestore?, database?, storage?})',
  description: 'Copy live into a branch.',
  args: z.object({ branch: branchName, candidateRules }),
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
    const candidate = args.candidateRules as string | BranchCandidateRules | undefined;
    const branch = await fork(await captureFullState(ctx.sandbox), candidate);
    const manifest = await saveBranch(ctx.projectDir, name, branch, { base: 'live' });
    branch.sandbox.dispose();
    return {
      ok: true,
      summary: `Forked branch '${name}' from the live sandbox.`,
      data: {
        branch: name,
        created: manifest.created,
        base: manifest.base,
        eventCount: manifest.eventCount,
        candidateRules: Object.keys(branch.candidateRules).sort(),
      },
    };
  },
} satisfies MethodRecord;
