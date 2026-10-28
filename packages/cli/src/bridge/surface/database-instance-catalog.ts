/**
 * The Realtime Database instances a `database` method may name.
 *
 * An instance is known when `firebase.json` declares it or the sandbox already
 * holds data for it, because an app can open an instance `firebase.json` never
 * names. The Node host builds its catalog from the instances it serves
 * (`serve/worker/host/rtdb-instance-catalog.ts`); the in-process sandbox and
 * the CLI runner read the project's files here.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { heldDatabaseInstances } from 'pyric/database/internal';
import { UNNAMED_DEFAULT_DATABASE_INSTANCE, isDefaultDatabaseInstance } from 'pyric/sandbox/internal';
import type { LocalSandbox } from 'pyric/sandbox';
import { readFirebaseJson } from '../../cli/firebase-json.js';
import { resolveFirebaseProject } from '../../cli/firebase-project.js';
import { databaseRulesTargets } from '../../serve/rules.js';

/** The instances a caller may name, as the refusal lists them. */
export interface KnownDatabaseInstances {
  /** The default instance's name, when the project names one. */
  defaultInstance?: string;
  /** Every other instance, declared first, then held. */
  named: string[];
  /** Why a `firebase.json` target selects no instance yet, one sentence each. */
  pending: string[];
}

export interface DatabaseInstanceCatalog {
  /**
   * The `getDatabase` selector for an instance name: `undefined` for the
   * default instance, the name for a known instance, and `null` when the
   * project has no such instance.
   */
  select(name: string): string | undefined | null;
  known(): KnownDatabaseInstances;
}

/**
 * Build a catalog from the default instance's name and the named instances.
 * `projectId`, when known, also names the default instance, as
 * `https://<projectId>.firebaseio.com` does for a project created before about 2020.
 */
export function databaseInstanceCatalog(known: KnownDatabaseInstances, projectId?: string): DatabaseInstanceCatalog {
  return {
    select(name) {
      if (name === known.defaultInstance || isDefaultDatabaseInstance(name, projectId)) return undefined;
      return known.named.includes(name) ? name : null;
    },
    known: () => known,
  };
}

/** The names in `names`, each once, in first-seen order, without `exclude`. */
export function distinctNames(names: readonly string[], exclude: string | undefined): string[] {
  return [...new Set(names)].filter((name) => name !== exclude);
}

/** The catalog for a project directory: its `firebase.json`, its project, and what `sandbox` holds. */
export async function projectDatabaseInstances(
  sandbox: LocalSandbox,
  projectDir: string,
): Promise<DatabaseInstanceCatalog> {
  const hasFirebaseJson = existsSync(join(projectDir, 'firebase.json'));
  const config = hasFirebaseJson ? await readFirebaseJson(projectDir) : null;
  const project = resolveFirebaseProject({ projectDir });
  const targets = databaseRulesTargets(projectDir, config, project);
  const isNamed = targets.defaultInstance !== UNNAMED_DEFAULT_DATABASE_INSTANCE;
  const defaultInstance = isNamed ? targets.defaultInstance : undefined;
  const declared = targets.targets.map((target) => target.instance);
  const projectId = project.projectId;
  const named = distinctNames([...declared, ...heldDatabaseInstances(sandbox)], targets.defaultInstance)
    .filter((name) => !isDefaultDatabaseInstance(name, projectId));
  return databaseInstanceCatalog({
    ...(defaultInstance === undefined ? {} : { defaultInstance }),
    named,
    pending: targets.pending.map((target) => `${target.label} target "${target.target}" selects no instance yet: ${target.reason}.`),
  }, projectId);
}
