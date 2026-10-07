import type { DatabaseInstancesRules, RtdbRulesJson } from './init-payload.js';

/** The per-instance Realtime Database rules operations a sandbox host provides. */
export interface DatabaseInstanceRulesHost {
  /** The instances `firebase.json` deploys rules to. */
  declareInstances(names: ReadonlySet<string>): void;
  /** Replace one instance's rules. Null clears them, so the default policy applies. */
  setDatabaseRules(instance: string, rules: RtdbRulesJson | null): void;
}

/** Applies one instance's reloaded rules to the host. */
export type DatabaseInstanceRulesReload = (instance: string, rules: RtdbRulesJson | null) => void;

/**
 * Apply a project's loaded per-instance rules to `host`: declare the
 * instances, then set each one's rules. Each instance is set on its own, so a
 * ruleset the host refuses leaves the others applied; the call then throws
 * naming each refused instance. Returns the function that applies one
 * declared instance's reloaded rules.
 */
export function connectDatabaseInstanceRules(
  host: DatabaseInstanceRulesHost,
  loaded: DatabaseInstancesRules,
): DatabaseInstanceRulesReload {
  const declared = new Set(Object.keys(loaded.rules));
  host.declareInstances(declared);
  const failures: string[] = [];
  for (const [instance, rules] of Object.entries(loaded.rules)) {
    try {
      host.setDatabaseRules(instance, rules);
    } catch (error) {
      failures.push(`database instance "${instance}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
  return (instance, rules) => {
    if (!declared.has(instance)) throw new Error(`database instance "${instance}" is not declared in firebase.json.`);
    host.setDatabaseRules(instance, rules);
  };
}
