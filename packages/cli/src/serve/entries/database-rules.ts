import type { Sandbox } from 'pyric/sandbox';
import { getDatabase, sandbox as controls, type Database } from 'pyric/database';
import {
  LOCKED_DATABASE_RULES,
  UNNAMED_DEFAULT_DATABASE_INSTANCE,
  defaultDatabaseInstanceName,
  lockedInstanceNotice,
  resolveDatabaseInstance,
} from 'pyric/sandbox/internal';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import type { DatabaseInstancesRules, RtdbRulesJson } from '../init-payload.js';

type Policy = 'allow' | 'deny';

/**
 * Deploy the served project's rules to each local database, each instance
 * its own ruleset, without sharing data between instances. A database opened
 * without a URL is the default instance the deployed config names. An
 * instance `firebase.json` deploys no rules to is locked, as production
 * creates a new instance, and its first use logs how to deploy its rules.
 */
export function createDatabaseRulesDeployment(sandbox: Sandbox) {
  /** Each opened store by instance name; the default instance under `undefined`. */
  const databases = new Map<string | undefined, Database>();
  let defaultInstance: string | undefined;
  let projectId: string | undefined;
  let rulesByInstance = new Map<string, RtdbRulesJson | null>();
  let defaultPolicy: Policy = 'deny';
  const noticed = new Set<string>();

  /** The default instance's name: the config's, else the app's project default once known. */
  function defaultName(): string | undefined {
    const named = defaultInstance !== undefined && defaultInstance !== UNNAMED_DEFAULT_DATABASE_INSTANCE;
    if (named) return defaultInstance;
    return projectId === undefined ? defaultInstance : defaultDatabaseInstanceName(projectId);
  }

  /** The rules deployed to the default instance, under its name or the config's unnamed default. */
  function defaultRules(): RtdbRulesJson | null {
    const name = defaultName();
    const byName = name === undefined ? undefined : rulesByInstance.get(name);
    return byName ?? (defaultInstance === undefined ? undefined : rulesByInstance.get(defaultInstance)) ?? null;
  }

  function apply(name: string | undefined, database: Database): void {
    controls.setDefaultPolicy(database, defaultPolicy);
    if (name === undefined) {
      controls.setRules(database, defaultRules());
      return;
    }
    const deployed = rulesByInstance.has(name);
    controls.setRules(database, deployed ? rulesByInstance.get(name) ?? null : LOCKED_DATABASE_RULES);
    if (!deployed && !noticed.has(name)) {
      noticed.add(name);
      console.warn(lockedInstanceNotice(name));
    }
  }

  function applyAll(): void {
    for (const [name, database] of databases) apply(name, database);
  }

  function refusalOf(instance: string, rules: RtdbRulesJson | null): string | null {
    const rejection = rules === null ? null : rtdbRulesSourceRejection(rules);
    if (rejection === null) return null;
    return `database instance "${instance}": ${rejection.message}`;
  }

  /**
   * Serve the instance a `getDatabase(app, url)` call opens; `url` is the URL
   * or the app's `databaseURL`, and `appProjectId` names the default instance
   * when the config could not.
   */
  function register(url?: string, appProjectId?: string): void {
    const learnsProject = projectId === undefined && appProjectId !== undefined;
    if (learnsProject) {
      projectId = appProjectId;
      applyAll();
    }
    const parsed = resolveDatabaseInstance(url)?.name;
    const name = parsed === defaultName() ? undefined : parsed;
    if (databases.has(name)) return;
    const database = getDatabase(sandbox, name);
    databases.set(name, database);
    apply(name, database);
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
      const next = new Map<string, RtdbRulesJson | null>();
      const refusals: string[] = [];
      for (const [instance, rules] of Object.entries(instances?.rules ?? {})) {
        const refusal = refusalOf(instance, rules);
        if (refusal !== null) refusals.push(refusal);
        else next.set(instance, rules);
      }
      defaultInstance = instances?.defaultInstance;
      rulesByInstance = next;
      defaultPolicy = policy;
      applyAll();
      if (refusals.length > 0) throw new Error(`database rules not loaded in the sandbox: ${refusals.join('; ')}`);
    },
    /** Replace one instance's rules. Throws, leaving its rules in force, when production would not load `rules`. */
    deployInstance(instance: string, rules: RtdbRulesJson | null, policy: Policy = defaultPolicy): void {
      const refusal = refusalOf(instance, rules);
      if (refusal !== null) throw new Error(`database rules not loaded in the sandbox: ${refusal}`);
      rulesByInstance.set(instance, rules);
      defaultPolicy = policy;
      applyAll();
    },
  };
}
