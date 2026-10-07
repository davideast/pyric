import type { Sandbox } from 'pyric/sandbox';
import { getDatabase, sandbox as controls, type Database } from 'pyric/database';
import { databaseInstanceKey, resolveDatabaseInstance, type DatabaseInstance } from 'pyric/sandbox/internal';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import type { DatabaseInstancesRules, RtdbRulesJson } from '../init-payload.js';

type Policy = 'allow' | 'deny';

/**
 * Deploy the served project's rules to each local database, each instance
 * its own ruleset, without sharing data between instances. A database opened
 * without a URL is the default instance the deployed config names.
 */
export function createDatabaseRulesDeployment(sandbox: Sandbox) {
  const databases = new Map<string, { instance: DatabaseInstance | undefined; database: Database }>();
  let defaultInstance: string | undefined;
  let rulesByInstance = new Map<string, RtdbRulesJson>();
  let defaultPolicy: Policy = 'deny';

  function apply(entry: { instance: DatabaseInstance | undefined; database: Database }): void {
    const name = databaseInstanceKey(entry.instance, defaultInstance);
    controls.setDefaultPolicy(entry.database, defaultPolicy);
    controls.setRules(entry.database, rulesByInstance.get(name) ?? null);
  }

  function refusalOf(instance: string, rules: RtdbRulesJson | null): string | null {
    const rejection = rules === null ? null : rtdbRulesSourceRejection(rules);
    if (rejection === null) return null;
    return `database instance "${instance}": ${rejection.message}`;
  }

  function register(url?: string): void {
    const instance = resolveDatabaseInstance(url);
    const key = databaseInstanceKey(instance);
    if (databases.has(key)) return;
    const entry = { instance, database: getDatabase(sandbox, url) };
    apply(entry);
    databases.set(key, entry);
  }

  register();
  return {
    register,
    /** The instance a database opened without a URL is, once a config is deployed. */
    defaultInstance: (): string | undefined => defaultInstance,
    /**
     * Replace every instance's rules. Each ruleset passes the load-time check
     * on its own: a refused one is not installed, the others are, and the
     * call then throws naming each refused instance.
     */
    deploy(instances: DatabaseInstancesRules | null, policy: Policy = 'deny'): void {
      const next = new Map<string, RtdbRulesJson>();
      const refusals: string[] = [];
      for (const [instance, rules] of Object.entries(instances?.rules ?? {})) {
        const refusal = refusalOf(instance, rules);
        if (refusal !== null) refusals.push(refusal);
        else if (rules !== null) next.set(instance, rules);
      }
      defaultInstance = instances?.defaultInstance;
      rulesByInstance = next;
      defaultPolicy = policy;
      for (const entry of databases.values()) apply(entry);
      if (refusals.length > 0) throw new Error(`database rules not loaded in the sandbox: ${refusals.join('; ')}`);
    },
    /** Replace one instance's rules. Throws, leaving its rules in force, when production would not load `rules`. */
    deployInstance(instance: string, rules: RtdbRulesJson | null, policy: Policy = defaultPolicy): void {
      const refusal = refusalOf(instance, rules);
      if (refusal !== null) throw new Error(`database rules not loaded in the sandbox: ${refusal}`);
      if (rules === null) rulesByInstance.delete(instance);
      else rulesByInstance.set(instance, rules);
      defaultPolicy = policy;
      for (const entry of databases.values()) apply(entry);
    },
  };
}
