/**
 * Installing Firestore rules into the sandbox from the CLI.
 *
 * Every CLI path that loads Firestore rules goes through here: `rules.set`,
 * the in-process server's project rules, and a seed's rules. Each runs
 * production's load check (`rulesSourceRejection`: the source parses and is
 * within the compile limits) and refuses a source that fails it, keeping the
 * rules in force, with the reason the check gives. The served worker's rules
 * deploy runs the same check (`serve/worker/host/rules.ts`).
 *
 * A source a load path refused, such as a project's `firestore.rules` saved
 * mid-edit or a seed that carries broken rules on purpose, stays readable to
 * lint and simulate while the rules in force at the refusal still are, so a
 * lint of the loaded project reports what is wrong with its file. Installing
 * other rules ends that.
 */
import type { LocalSandbox } from 'pyric/sandbox';
import {
  DEFAULT_FIRESTORE_DATABASE,
  getDatabaseEnv,
  normalizeFirestoreDatabaseId,
} from 'pyric/firestore/internal';
import { setRules } from 'pyric/sandbox/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { rulesSourceRejection, type RulesSourceRejection } from 'pyric/rules/internal';

/** A refused source per database, and the rules that were in force when it was refused. */
const refusedLoads = new WeakMap<LocalSandbox, Map<string, { source: string; inForce: string }>>();

function refusedMapFor(sandbox: LocalSandbox, create: boolean): Map<string, { source: string; inForce: string }> | undefined {
  let map = refusedLoads.get(sandbox);
  if (map === undefined && create) {
    map = new Map();
    refusedLoads.set(sandbox, map);
  }
  return map;
}

/** The Firestore rules source the sandbox enforces for `databaseId` (defaults to `(default)`). */
export function firestoreRulesInForce(sandbox: LocalSandbox, databaseId?: string): string {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    return getInternalEnv(sandbox).getRules();
  }
  return getDatabaseEnv(sandbox, normalized).getRules();
}

/**
 * Install `source` as the sandbox's Firestore rules when production would
 * load it. Otherwise keep the rules in force and return why.
 */
export function installFirestoreRules(
  sandbox: LocalSandbox,
  source: string,
  databaseId?: string,
): RulesSourceRejection | null {
  const rejection = rulesSourceRejection(source);
  if (rejection !== null) return rejection;
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    setRules(sandbox, source);
  } else {
    setRules(sandbox, source, normalized);
  }
  refusedLoads.get(sandbox)?.delete(normalized);
  return null;
}

/**
 * {@link installFirestoreRules} for a load path, returning the reason it
 * refused the source: `Firestore rules did not parse at line 4, column 44:
 * ...` or `Firestore rules did not compile: Line 17: ...`. A refused source
 * stays readable through {@link firestoreRulesSource} until other rules are
 * installed.
 */
export function loadFirestoreRules(
  sandbox: LocalSandbox,
  source: string,
  databaseId?: string,
): string | null {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  const rejection = installFirestoreRules(sandbox, source, normalized);
  if (rejection === null) return null;
  refusedMapFor(sandbox, true)!.set(normalized, {
    source,
    inForce: firestoreRulesInForce(sandbox, normalized),
  });
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    return `Firestore ${rejection.message}`;
  }
  return `Firestore (${normalized}) ${rejection.message}`;
}

/** Remember a refused raw rules source so lint and simulate inspect it while existing rules stay in force. */
export function rememberRefusedFirestoreRules(
  sandbox: LocalSandbox,
  source: string,
  databaseId?: string,
): void {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  refusedMapFor(sandbox, true)!.set(normalized, {
    source,
    inForce: firestoreRulesInForce(sandbox, normalized),
  });
}

/**
 * The Firestore rules source lint and simulate read: the source a load path
 * refused, while the rules in force at the refusal still are, or else the
 * rules in force.
 */
export function firestoreRulesSource(sandbox: LocalSandbox, databaseId?: string): string {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  const inForce = firestoreRulesInForce(sandbox, normalized);
  const refused = refusedLoads.get(sandbox)?.get(normalized);
  if (refused !== undefined && refused.inForce === inForce) {
    return refused.source;
  }
  return inForce;
}
