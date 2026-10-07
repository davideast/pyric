/**
 * Installing Realtime Database rules into the sandbox from the CLI.
 *
 * `rules.set` and a seed's rules load through here. Each runs the check every
 * RTDB rules load path runs (`rtdbRulesSourceRejection`: the ruleset is a
 * rules document and none of its rules carries an error finding, which is
 * what `firebase deploy` refuses) and keeps the rules in force on a refusal.
 *
 * A ruleset a load path refused, such as a seed that carries broken rules on
 * purpose, stays readable to lint while the rules in force at the refusal
 * still are, so a lint of the loaded sandbox reports what is wrong with it.
 * Installing other rules ends that.
 */
import type { LocalSandbox } from 'pyric/sandbox';
import { getActiveRules, setRules } from 'pyric/sandbox/database';
import type { RtdbRulesJson } from 'pyric/sandbox/database';
import { rtdbRulesSourceRejection, type RtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';

/** A refused ruleset, and the rules that were in force when it was refused. */
const refusedLoads = new WeakMap<LocalSandbox, { ruleset: RtdbRulesJson; inForce: string }>();

function inForceKey(sandbox: LocalSandbox): string {
  return JSON.stringify(getActiveRules(sandbox));
}

/**
 * Install `rules` as the sandbox's database rules when production would load
 * them. Otherwise keep the rules in force and return why.
 */
export function installDatabaseRules(sandbox: LocalSandbox, rules: RtdbRulesJson): RtdbRulesSourceRejection | null {
  const rejection = rtdbRulesSourceRejection(rules);
  if (rejection !== null) return rejection;
  setRules(sandbox, rules);
  refusedLoads.delete(sandbox);
  return null;
}

/**
 * {@link installDatabaseRules} for a load path, returning the reason it
 * refused. A refused ruleset stays readable through
 * {@link databaseRulesSource} until other rules are installed.
 */
export function loadDatabaseRules(sandbox: LocalSandbox, rules: RtdbRulesJson): string | null {
  const rejection = installDatabaseRules(sandbox, rules);
  if (rejection === null) return null;
  refusedLoads.set(sandbox, { ruleset: rules, inForce: inForceKey(sandbox) });
  return rejection.message;
}

/**
 * The database rules lint reads: the ruleset a load path refused, while the
 * rules in force at the refusal still are, or else the rules in force.
 */
export function databaseRulesSource(sandbox: LocalSandbox): RtdbRulesJson | null {
  const refused = refusedLoads.get(sandbox);
  if (refused !== undefined && refused.inForce === inForceKey(sandbox)) return refused.ruleset;
  return getActiveRules(sandbox);
}
