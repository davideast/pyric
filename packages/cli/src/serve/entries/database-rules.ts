import type { Sandbox } from 'pyric/sandbox';
import { getDatabase, sandbox as controls, type Database } from 'pyric/database';
import {
  LOCKED_DATABASE_RULES,
  UNNAMED_DEFAULT_DATABASE_INSTANCE,
  defaultDatabaseInstanceName,
  isDefaultDatabaseInstance,
  undeployedInstanceNotice,
  resolveDatabaseInstance,
} from 'pyric/sandbox/internal';
import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import type { DatabaseInstancesRules, RtdbRulesJson } from '../init-payload.js';
import {
  createPendingDatabaseTargets,
  defaultInstanceDeploy,
  twoDefaultRulesFilesMessage,
  type DatabaseTargetDeploy,
} from '../database-instance-rules-host.js';

type Policy = 'allow' | 'deny';

/**
 * Deploy the served project's rules to each local database, each instance
 * its own ruleset, without sharing data between instances. A database opened
 * without a URL is the default instance the deployed config names. An
 * instance `firebase.json` deploys no rules to is locked, as production
 * creates a new instance, or open in permissive mode, and its first use logs
 * how to deploy its rules. `<projectId>`, the name a project created before
 * about 2020 gives its default instance, is the default instance too.
 */
export function createDatabaseRulesDeployment(sandbox: Sandbox) {
  /** Each opened store by instance name; the default instance under `undefined`. */
  const databases = new Map<string | undefined, Database>();
  let defaultInstance: string | undefined;
  let projectId: string | undefined;
  let rulesByInstance = new Map<string, RtdbRulesJson | null>();
  let rulesFiles: Record<string, string> = {};
  let defaultPolicy: Policy = 'deny';
  let pendingTargets = createPendingDatabaseTargets();
  const noticed = new Set<string>();

  /** The default instance's name: the config's, else the app's project default once known. */
  function defaultName(): string | undefined {
    const named = defaultInstance !== undefined && defaultInstance !== UNNAMED_DEFAULT_DATABASE_INSTANCE;
    if (named) return defaultInstance;
    return projectId === undefined ? defaultInstance : defaultDatabaseInstanceName(projectId);
  }

  /** Whether `name` is the default instance: its name, or another name of the project's default instance. */
  function isDefaultName(name: string): boolean {
    return name === defaultName() || isDefaultDatabaseInstance(name, projectId);
  }

  /**
   * The rules deployed to the default instance, under any of its names or the
   * config's unnamed default. Different rules under two of its names are
   * refused, as `firebase.json` is refused at startup: the instance is locked.
   */
  function defaultRules(): RtdbRulesJson | null {
    const names = [defaultName(), projectId, defaultInstance].filter((name): name is string => name !== undefined);
    const deployed = [...new Set(names)].filter((name) => rulesByInstance.has(name));
    const [first, ...others] = deployed;
    if (first === undefined) return null;
    const rules = rulesByInstance.get(first) ?? null;
    const conflicting = others.find((other) => JSON.stringify(rulesByInstance.get(other) ?? null) !== JSON.stringify(rules));
    if (conflicting === undefined) return rules;
    reportConflict(first, conflicting);
    return LOCKED_DATABASE_RULES;
  }

  const reportedConflicts = new Set<string>();
  function reportConflict(first: string, second: string): void {
    const key = `${first}|${second}`;
    if (reportedConflicts.has(key) || projectId === undefined) return;
    reportedConflicts.add(key);
    const message = twoDefaultRulesFilesMessage(
      defaultDatabaseInstanceName(projectId),
      projectId,
      defaultInstanceDeploy(first, rulesFiles),
      defaultInstanceDeploy(second, rulesFiles),
    );
    console.error(`[pyric sandbox] ${message}`);
  }

  function apply(name: string | undefined, database: Database): void {
    controls.setDefaultPolicy(database, defaultPolicy);
    if (name === undefined) {
      controls.setRules(database, defaultRules());
      return;
    }
    const deployed = rulesByInstance.has(name);
    // Without deployed rules an instance is locked, as production creates one,
    // or open in permissive mode, as the default instance is.
    const undeployed = defaultPolicy === 'allow' ? null : LOCKED_DATABASE_RULES;
    controls.setRules(database, deployed ? rulesByInstance.get(name) ?? null : undeployed);
    if (!deployed && !noticed.has(name)) {
      noticed.add(name);
      console.warn(undeployedInstanceNotice(name, defaultPolicy));
    }
  }

  function applyAll(): void {
    for (const [name, database] of databases) apply(name, database);
  }

  /** Deploy targets no project resolved at server start take their rules
   *  once the app's project id is known. */
  function resolvePendingTargets(): void {
    if (projectId === undefined) return;
    const { deploys, notices } = pendingTargets.resolve(projectId);
    for (const notice of notices) console.info(`[pyric sandbox] ${notice}`);
    setTargetDeploys(deploys);
  }

  function setTargetDeploys(deploys: readonly DatabaseTargetDeploy[]): void {
    const refusals: string[] = [];
    for (const { instance, rules } of deploys) {
      const refusal = refusalOf(instance, rules);
      if (refusal !== null) refusals.push(refusal);
      else rulesByInstance.set(instance, rules);
    }
    if (refusals.length > 0) throw new Error(`database rules not loaded in the sandbox: ${refusals.join('; ')}`);
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
      resolvePendingTargets();
      applyAll();
    }
    const parsed = resolveDatabaseInstance(url)?.name;
    const name = parsed === undefined || isDefaultName(parsed) ? undefined : parsed;
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
    /** The default instance's name: the config's, else the app's project default once the app names its project. */
    defaultName,
    /** Whether `name` names the default instance. */
    isDefaultName,
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
      projectId = instances?.projectId ?? projectId;
      rulesFiles = instances?.rulesFiles ?? {};
      rulesByInstance = next;
      defaultPolicy = policy;
      pendingTargets = createPendingDatabaseTargets(instances?.pendingTargets);
      try {
        resolvePendingTargets();
      } finally {
        applyAll();
      }
      if (refusals.length > 0) throw new Error(`database rules not loaded in the sandbox: ${refusals.join('; ')}`);
    },
    /**
     * Replace an unresolved deploy target's rules. Once the app's project
     * resolved the target, its instances take them; before that, they are
     * kept for resolution.
     */
    deployTarget(target: string, rules: RtdbRulesJson | null, policy: Policy = defaultPolicy): void {
      defaultPolicy = policy;
      try {
        setTargetDeploys(pendingTargets.update(target, rules));
      } finally {
        applyAll();
      }
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
