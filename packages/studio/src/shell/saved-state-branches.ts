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
  DEFAULT_FIRESTORE_DATABASE,
  declareFirestoreDatabase,
  getDatabaseEnv,
  isFirestoreDatabaseDeclared,
  isFirestoreDatabaseLockedByDefault,
  listDeclaredFirestoreDatabases,
  normalizeFirestoreDatabaseId,
} from 'pyric/firestore/internal';
import {
  diffFullStates,
  fork,
  type Branch,
  type BranchDivergence,
  type FullSandboxState,
  type LocalSandbox,
  type SandboxSnapshot,
} from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';

export interface SavedNamedFirestoreSnapshot extends SandboxSnapshot {
  firestoreDeclared?: string[];
  firestoreDatabases?: Record<string, Record<string, Record<string, unknown>>>;
  firestoreDatabaseRules?: Record<string, string>;
  firestoreLocked?: string[];
}

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

/** Capture `sandbox.snapshot()` enriched with any declared named Firestore databases, rules, and locked defaults. */
export function snapshotWithNamedFirestore(sandbox: LocalSandbox): SavedNamedFirestoreSnapshot {
  const base = sandbox.snapshot();
  const declared = listDeclaredFirestoreDatabases(sandbox);
  if (declared.length === 0) {
    return base;
  }
  const firestoreDatabases: Record<string, Record<string, Record<string, unknown>>> = {};
  const firestoreDatabaseRules: Record<string, string> = {};
  const firestoreLocked: string[] = [];
  let hasNamedRules = false;
  for (const dbId of declared) {
    const env = getDatabaseEnv(sandbox, dbId);
    firestoreDatabases[dbId] = structuredClone(env.snapshot());
    const explicitRules = env.getExplicitRules();
    if (explicitRules !== null && explicitRules.length > 0) {
      firestoreDatabaseRules[dbId] = explicitRules;
      hasNamedRules = true;
    }
    if (isFirestoreDatabaseLockedByDefault(sandbox, dbId)) {
      firestoreLocked.push(dbId);
    }
  }
  const enriched: SavedNamedFirestoreSnapshot = {
    ...base,
    firestoreDeclared: declared,
    firestoreDatabases,
  };
  if (hasNamedRules) {
    enriched.firestoreDatabaseRules = firestoreDatabaseRules;
  }
  if (firestoreLocked.length > 0) {
    enriched.firestoreLocked = firestoreLocked;
  }
  return enriched;
}

/**
 * The full-state view of one saved state: the documents it carries, and
 * nothing else. Used on both sides of a comparison, so the services a saved
 * state does not describe cancel out instead of reading as differences.
 */
export function savedStateOf(saved: SandboxSnapshot): FullSandboxState {
  return { ...emptyState(), firestore: saved.firestore };
}

function hydrateNamedFirestoreOntoSandbox(
  sandbox: LocalSandbox,
  saved: SavedNamedFirestoreSnapshot,
  targetDatabaseId?: string,
): void {
  const lockedSet = new Set(saved.firestoreLocked ?? []);
  const ids = new Set<string>(saved.firestoreDeclared ?? []);
  for (const dbId of Object.keys(saved.firestoreDatabases ?? {})) {
    if (dbId !== DEFAULT_FIRESTORE_DATABASE) ids.add(dbId);
  }
  for (const dbId of Object.keys(saved.firestoreDatabaseRules ?? {})) {
    if (dbId !== DEFAULT_FIRESTORE_DATABASE) ids.add(dbId);
  }
  for (const dbId of lockedSet) {
    if (dbId !== DEFAULT_FIRESTORE_DATABASE) ids.add(dbId);
  }
  const normalizedTarget = normalizeFirestoreDatabaseId(targetDatabaseId);
  if (normalizedTarget !== DEFAULT_FIRESTORE_DATABASE) {
    ids.add(normalizedTarget);
  }
  for (const dbId of [...ids].sort()) {
    declareFirestoreDatabase(sandbox, dbId, { locked: lockedSet.has(dbId) });
    const env = getDatabaseEnv(sandbox, dbId);
    const ruleSource = saved.firestoreDatabaseRules?.[dbId];
    if (typeof ruleSource === 'string' && ruleSource.length > 0) {
      env.deployRules(ruleSource);
    }
    const docs = saved.firestoreDatabases?.[dbId];
    if (docs !== undefined) {
      for (const [docPath, docData] of Object.entries(docs)) {
        env.adminSetDocument(docPath, structuredClone(docData));
      }
    }
  }
}

/**
 * A branch standing on one saved state, under an optional candidate ruleset.
 *
 * @param saved The state to stand the branch on, loaded whole.
 * @param candidateRules Firestore rules the branch runs under. The empty
 *                       source leaves the saved state's own rules in place.
 * @param databaseId Optional Firestore database id `candidateRules` targets.
 */
export async function forkFromSavedState(
  saved: SandboxSnapshot,
  candidateRules = '',
  databaseId?: string,
): Promise<Branch> {
  const branch = await fork(emptyState());
  branch.sandbox.loadSnapshot(saved);
  hydrateNamedFirestoreOntoSandbox(
    branch.sandbox,
    saved as SavedNamedFirestoreSnapshot,
    databaseId,
  );
  if (candidateRules !== '') {
    const normalizedDb = normalizeFirestoreDatabaseId(databaseId);
    let targetDbArg: string | undefined;
    if (normalizedDb !== DEFAULT_FIRESTORE_DATABASE) {
      targetDbArg = normalizedDb;
    }
    setFirestoreRules(branch.sandbox as unknown as LocalSandbox, candidateRules, targetDbArg);
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
  databaseId?: string,
): BranchDivergence[] {
  const normalizedDb = normalizeFirestoreDatabaseId(databaseId);
  if (normalizedDb === DEFAULT_FIRESTORE_DATABASE) {
    return diffFullStates(savedStateOf(reference), savedStateOf(branch.sandbox.snapshot()));
  }
  const referenceNamed = reference as SavedNamedFirestoreSnapshot;
  const referenceDocs = referenceNamed.firestoreDatabases?.[normalizedDb] ?? {};
  let branchDocs: Record<string, Record<string, unknown>> = {};
  if (isFirestoreDatabaseDeclared(branch.sandbox, normalizedDb)) {
    branchDocs = getDatabaseEnv(branch.sandbox, normalizedDb).snapshot();
  }
  return diffFullStates(
    { ...emptyState(), firestore: referenceDocs },
    { ...emptyState(), firestore: branchDocs },
  );
}
