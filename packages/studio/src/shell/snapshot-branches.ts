/**
 * Branching from a snapshot, which is all Studio ever has.
 *
 * The branch engine forks from a {@link FullSandboxState}, which is read off a
 * live sandbox. Studio does not hold one: the sandbox lives in the worker and
 * what crosses the port is a {@link SandboxSnapshot}. So every Studio feature
 * that stages a change on a copy, the proposals panel and the rules rerun,
 * goes through here.
 *
 * A branch forked this way stands on a fresh sandbox with the snapshot loaded
 * into it, so it reads what the snapshot held in every service the snapshot
 * carried. The candidate ruleset is installed after the load, because loading
 * a snapshot replaces the rules with the snapshot's own.
 *
 * The comparisons Studio draws are over documents, which is what a snapshot
 * carries as first-class state, so both sides of a comparison are lifted the
 * same way and only the documents can diverge. A service the snapshot does not
 * describe is empty on both sides and reports nothing rather than reporting
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

/** A state holding nothing at all, the baseline a snapshot is loaded over. */
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
 * The full-state view of one snapshot: the documents it carries, and nothing
 * else. Used on both sides of a comparison, so the services a snapshot does
 * not describe cancel out instead of reading as differences.
 */
export function snapshotState(snapshot: SandboxSnapshot): FullSandboxState {
  return { ...emptyState(), firestore: snapshot.firestore };
}

/**
 * A branch standing on one snapshot, under an optional candidate ruleset.
 *
 * @param snapshot The state to stand the branch on, loaded whole.
 * @param candidateRules Firestore rules the branch runs under. The empty
 *                       source leaves the snapshot's own rules in place.
 */
export async function forkFromSnapshot(
  snapshot: SandboxSnapshot,
  candidateRules = '',
): Promise<Branch> {
  const branch = await fork(emptyState());
  branch.sandbox.loadSnapshot(snapshot);
  if (candidateRules !== '') {
    setFirestoreRules(branch.sandbox as unknown as LocalSandbox, candidateRules);
  }
  return branch;
}

/**
 * The documents one branch and one snapshot disagree on. The branch's own
 * snapshot is lifted the same way the reference is, so the answer is the
 * document drift and nothing else.
 */
export function documentDivergences(
  branch: Branch,
  reference: SandboxSnapshot,
): BranchDivergence[] {
  return diffFullStates(snapshotState(reference), snapshotState(branch.sandbox.snapshot()));
}
