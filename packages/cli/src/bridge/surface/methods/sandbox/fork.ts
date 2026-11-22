/**
 * Fork the live sandbox into a persisted branch.
 *
 * The fork captures the whole live sandbox, not its Firestore documents: a
 * branch reads identically to live in every service, so an experiment that
 * uploads an object or creates an account starts from the state live actually
 * holds rather than from an empty one.
 *
 * `candidateRules` names the rule sources the branch runs under in place of
 * live's. A string is Firestore rules, which is the common case (or a Realtime
 * Database JSON ruleset when it parses as JSON with a top-level `rules` key);
 * an object names each service, so a branch can try a Storage or Realtime
 * Database ruleset without touching the other two. Candidate sources that
 * production's load check refuses are rejected before the branch is created.
 */
import { captureNamedFirestoreState } from 'pyric/firestore/internal';
import { toStrictRulesJson } from 'pyric/rules/internal/rtdb';
import { captureFullState, fork, type BranchCandidateRules } from 'pyric/sandbox';
import { saveBranch } from 'pyric/sandbox/branches/store';
import { z } from 'zod';

import { branchExists, branchName, candidateRules } from '../../arguments/sandbox.js';
import { writeBranchNamedFirestore } from '../../branch-firestore-databases.js';
import { operationFailure } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';
import { rulesEngineFor } from '../../rules-engines/registry.js';

function isJsonDatabaseRuleset(source: string): boolean {
  if (!source.trim().startsWith('{')) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(toStrictRulesJson(source));
  } catch {
    return false;
  }
  const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  if (!isObject) {
    return false;
  }
  return 'rules' in (parsed as Record<string, unknown>);
}

function checkCandidateRulesLoad(
  candidate: string | BranchCandidateRules | undefined,
): string | null {
  if (candidate === undefined) {
    return null;
  }
  if (typeof candidate === 'string') {
    if (isJsonDatabaseRuleset(candidate)) {
      const dbProblem = rulesEngineFor('database').compileFailure(candidate);
      if (dbProblem !== null) {
        return `${dbProblem.body} ${dbProblem.fix}`;
      }
      return null;
    }
    const fsProblem = rulesEngineFor('firestore').compileFailure(candidate);
    if (fsProblem !== null) {
      return `Firestore ${fsProblem.body} ${fsProblem.fix}`;
    }
    return null;
  }
  if (candidate.firestore !== undefined) {
    const fsProblem = rulesEngineFor('firestore').compileFailure(candidate.firestore);
    if (fsProblem !== null) {
      return `Firestore ${fsProblem.body} ${fsProblem.fix}`;
    }
  }
  if (candidate.database !== undefined) {
    const dbProblem = rulesEngineFor('database').compileFailure(JSON.stringify(candidate.database));
    if (dbProblem !== null) {
      return `${dbProblem.body} ${dbProblem.fix}`;
    }
  }
  if (candidate.storage !== undefined) {
    const storageProblem = rulesEngineFor('storage').compileFailure(candidate.storage);
    if (storageProblem !== null) {
      return `Storage ${storageProblem.body} ${storageProblem.fix}`;
    }
  }
  return null;
}

export default {
  tool: 'sandbox',
  method: 'fork',
  runsIn: 'bridge',
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
    const refusal = checkCandidateRulesLoad(candidate);
    if (refusal !== null) {
      return operationFailure(refusal);
    }
    const baseNamed = captureNamedFirestoreState(ctx.sandbox);
    const branch = await fork(await captureFullState(ctx.sandbox), candidate);
    const manifest = await saveBranch(ctx.projectDir, name, branch, { base: 'live' });
    writeBranchNamedFirestore(ctx.projectDir, name, baseNamed, baseNamed);
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
