/**
 * Branching from a saved state, which is all Studio ever has.
 *
 * The branch engine forks from a {@link FullSandboxState}, which is read off a
 * live sandbox. Studio does not hold one: the sandbox lives in the worker and
 * what crosses the port is the saved state of it that the worker hands back.
 * So every Studio feature that stages a change on a copy, the proposals panel
 * and the rules rerun, goes through here.
 *
 * A branch forked this way stands on a fresh sandbox with the saved state
 * loaded into it, so it reads what that state held in every service the state
 * carried. The candidate ruleset is installed after the load, because loading a
 * saved state replaces the rules with the ones it carries.
 *
 * The comparisons Studio draws are over documents, which is what a saved state
 * carries as first-class state, so both sides of a comparison are lifted the
 * same way and only the documents can diverge. A service the saved state does
 * not describe is empty on both sides and reports nothing rather than reporting
 * itself as a difference.
 */
import {
  diffFullStates,
  fork,
  type Branch,
  type BranchDivergence,
  type FullSandboxState,
  type SandboxSnapshot,
} from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import type { LocalSandbox } from 'pyric/sandbox';

/** A state holding nothing at all, the baseline a saved state is loaded over. */
function emptyState(): FullSandboxState {
  return {
    firestore: {},
    database: null,
    storage: [],
    auth: { users: [], providers: {} },
    rules: { firestore: '', database: null, storage: null },
  };
}

/**
 * The full-state view of one saved state: the documents it carries, and
 * nothing else. Used on both sides of a comparison, so the services a saved
 * state does not describe cancel out instead of reading as differences.
 */
export function savedStateOf(saved: SandboxSnapshot): FullSandboxState {
  return { ...emptyState(), firestore: saved.firestore };
}

/**
 * A branch standing on one saved state, under an optional candidate ruleset.
 *
 * @param saved The state to stand the branch on, loaded whole.
 * @param candidateRules Firestore rules the branch runs under. The empty
 *                       source leaves the saved state's own rules in place.
 */
export async function forkFromSavedState(
  saved: SandboxSnapshot,
  candidateRules = '',
): Promise<Branch> {
  const branch = await fork(emptyState());
  branch.sandbox.loadSnapshot(saved);
  if (candidateRules !== '') {
    setFirestoreRules(branch.sandbox as unknown as LocalSandbox, candidateRules);
  }
  return branch;
}

/**
 * The documents one branch and one saved state disagree on. The branch's own
 * state is lifted the same way the reference is, so the answer is the document
 * drift and nothing else.
 */
export function documentDivergences(
  branch: Branch,
  reference: SandboxSnapshot,
): BranchDivergence[] {
  return diffFullStates(savedStateOf(reference), savedStateOf(branch.sandbox.snapshot()));
}
