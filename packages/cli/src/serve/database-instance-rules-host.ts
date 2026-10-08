import { databaseInstanceNamed } from 'pyric/sandbox/internal';
import type { DatabaseInstancesRules, PendingDatabaseTargetRules, RtdbRulesJson } from './init-payload.js';

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

/** One instance's rules a resolved deploy target sets. */
export interface DatabaseTargetDeploy {
  instance: string;
  rules: RtdbRulesJson | null;
}

/**
 * The `firebase.json` deploy targets no project resolved when the server
 * started. Until the page's app config names a project, their instances
 * follow the default policy.
 */
export interface PendingDatabaseTargets {
  /**
   * Resolve every target with the app config's project id. Returns each
   * instance to set and one notice per target. Only the first call resolves.
   */
  resolve(projectId: string): { deploys: DatabaseTargetDeploy[]; notices: string[] };
  /**
   * Replace a target's rules after its rules file changed. Returns the
   * instances to set once the target resolved; before that, the rules are
   * kept for resolution.
   */
  update(target: string, rules: RtdbRulesJson | null): DatabaseTargetDeploy[];
}

/** Hold `pending` until the app config names a project; see {@link PendingDatabaseTargets}. */
export function createPendingDatabaseTargets(
  pending: readonly PendingDatabaseTargetRules[] = [],
): PendingDatabaseTargets {
  const targets = new Map(pending.map((entry) => [entry.target, { ...entry }]));
  const resolved = new Map<string, string[]>();
  let resolvedProject: string | undefined;

  return {
    resolve(projectId) {
      const deploys: DatabaseTargetDeploy[] = [];
      const notices: string[] = [];
      if (resolvedProject !== undefined) return { deploys, notices };
      resolvedProject = projectId;
      for (const entry of targets.values()) {
        const instances: string[] = [];
        for (const name of entry.instancesByProject[projectId] ?? []) {
          try {
            instances.push(databaseInstanceNamed(name).name);
          } catch (error) {
            const reason = error instanceof Error ? error.message.trim() : String(error);
            notices.push(`RTDB deploy target "${entry.target}" maps "${name}", which is not a database instance name: ${reason}`);
          }
        }
        if (instances.length === 0) {
          notices.push(`RTDB deploy target "${entry.target}" has no .firebaserc mapping for the app config project "${projectId}"; its instances keep the default policy.`);
          continue;
        }
        resolved.set(entry.target, instances);
        for (const instance of instances) deploys.push({ instance, rules: entry.rules });
        const noun = instances.length === 1 ? 'instance' : 'instances';
        notices.push(`RTDB deploy target "${entry.target}" resolved with the app config project "${projectId}": its rules now apply to ${noun} ${instances.join(', ')}.`);
      }
      return { deploys, notices };
    },
    update(target, rules) {
      const entry = targets.get(target);
      if (entry === undefined) return [];
      entry.rules = rules;
      return (resolved.get(target) ?? []).map((instance) => ({ instance, rules }));
    },
  };
}
