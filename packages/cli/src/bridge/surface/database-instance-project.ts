/**
 * The Realtime Database instances a project directory declares, for the
 * in-process sandbox and the CLI runner, which have no host to ask. It reads
 * `firebase.json`, so it runs only in the bridge process.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { heldDatabaseInstances } from 'pyric/database/internal';
import { UNNAMED_DEFAULT_DATABASE_INSTANCE, isDefaultDatabaseInstance } from 'pyric/sandbox/internal';
import type { LocalSandbox } from 'pyric/sandbox';
import { readFirebaseJson } from '../../cli/firebase-json.js';
import { resolveFirebaseProject } from '../../cli/firebase-project.js';
import { databaseRulesTargets } from '../../serve/rules.js';
import {
  databaseInstanceCatalog,
  distinctNames,
  type DatabaseInstanceCatalog,
} from './database-instance-catalog.js';

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
