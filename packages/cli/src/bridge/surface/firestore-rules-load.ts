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
import { setRules } from 'pyric/sandbox/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { rulesSourceRejection, type RulesSourceRejection } from 'pyric/rules/internal';

/** A refused source, and the rules that were in force when it was refused. */
const refusedLoads = new WeakMap<LocalSandbox, { source: string; inForce: string }>();

/** The Firestore rules source the sandbox enforces. */
export function firestoreRulesInForce(sandbox: LocalSandbox): string {
  return getInternalEnv(sandbox).getRules();
}

/**
 * Install `source` as the sandbox's Firestore rules when production would
 * load it. Otherwise keep the rules in force and return why.
 */
export function installFirestoreRules(sandbox: LocalSandbox, source: string): RulesSourceRejection | null {
  const rejection = rulesSourceRejection(source);
  if (rejection !== null) return rejection;
  setRules(sandbox, source);
  refusedLoads.delete(sandbox);
  return null;
}

/**
 * {@link installFirestoreRules} for a load path, returning the reason it
 * refused the source: `Firestore rules did not parse at line 4, column 44:
 * ...` or `Firestore rules did not compile: Line 17: ...`. A refused source
 * stays readable through {@link firestoreRulesSource} until other rules are
 * installed.
 */
export function loadFirestoreRules(sandbox: LocalSandbox, source: string): string | null {
  const rejection = installFirestoreRules(sandbox, source);
  if (rejection === null) return null;
  refusedLoads.set(sandbox, { source, inForce: firestoreRulesInForce(sandbox) });
  return `Firestore ${rejection.message}`;
}

/**
 * The Firestore rules source lint and simulate read: the source a load path
 * refused, while the rules in force at the refusal still are, or else the
 * rules in force.
 */
export function firestoreRulesSource(sandbox: LocalSandbox): string {
  const inForce = firestoreRulesInForce(sandbox);
  const refused = refusedLoads.get(sandbox);
  return refused !== undefined && refused.inForce === inForce ? refused.source : inForce;
}
