/**
 * The Realtime Database instances a project directory declares, for the
 * in-process sandbox and the CLI runner, which have no host to ask. It reads
 * `firebase.json` and `pyric.json`, so it runs only in the bridge process.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { heldDatabaseInstances } from 'pyric/database/internal';
import { UNNAMED_DEFAULT_DATABASE_INSTANCE, isDefaultDatabaseInstance } from 'pyric/sandbox/internal';
import type { LocalSandbox } from 'pyric/sandbox';
import { readFirebaseJson, type FirebaseJson } from '../../cli/firebase-json.js';
import { resolveFirebaseProject } from '../../cli/firebase-project.js';
import { readPyricConfigProjectSync } from '../../serve/live-project.js';
import { databaseRulesTargets, type DatabaseRulesTargets } from '../../serve/rules.js';
import {
  databaseInstanceCatalog,
  distinctNames,
  type DatabaseInstanceCatalog,
  type KnownDatabaseInstances,
} from './database-instance-catalog.js';

/**
 * When a project has a resolved `projectId` and `firebase.json` explicitly
 * declares a single RTDB instance in its `database` array, that sole declared
 * instance is the project's default RTDB instance.
 */
function selectConfiguredDefaultInstance(
  config: FirebaseJson | null,
  projectId: string | undefined,
  targets: DatabaseRulesTargets,
): string {
  if (
    projectId !== undefined &&
    Array.isArray(config?.database) &&
    targets.targets.length === 1 &&
    targets.pending.length === 0
  ) {
    return targets.targets[0]!.instance;
  }
  return targets.defaultInstance;
}

/** Resolve a project directory's Firebase project ID and configured default RTDB instance. */
export async function resolveProjectAndDefaultInstance(
  projectDir: string,
): Promise<{ projectId: string; defaultInstance: string }> {
  let config: FirebaseJson | null = null;
  if (existsSync(join(projectDir, 'firebase.json'))) {
    config = await readFirebaseJson(projectDir);
  }
  const project = resolveFirebaseProject({
    projectDir,
    configProject: readPyricConfigProjectSync(projectDir),
  });
  const projectId = project.projectId ?? 'demo-project';
  const targets = databaseRulesTargets(projectDir, config, project);
  const configured = selectConfiguredDefaultInstance(config, project.projectId, targets);
  const isNamed = configured !== UNNAMED_DEFAULT_DATABASE_INSTANCE;
  const defaultInstance = isNamed ? configured : `${projectId}-default-rtdb`;
  return { projectId, defaultInstance };
}

/** The catalog for a project directory: its `firebase.json`, its project, and what `sandbox` holds. */
export async function projectDatabaseInstances(
  sandbox: LocalSandbox,
  projectDir: string,
): Promise<DatabaseInstanceCatalog> {
  let config: FirebaseJson | null = null;
  if (existsSync(join(projectDir, 'firebase.json'))) {
    config = await readFirebaseJson(projectDir);
  }
  const project = resolveFirebaseProject({
    projectDir,
    configProject: readPyricConfigProjectSync(projectDir),
  });
  const projectId = project.projectId;
  const targets = databaseRulesTargets(projectDir, config, project);
  const configured = selectConfiguredDefaultInstance(config, projectId, targets);
  const isNamed = configured !== UNNAMED_DEFAULT_DATABASE_INSTANCE;
  const defaultInstance = isNamed ? configured : undefined;
  const declared = targets.targets.map((target) => target.instance);
  const named = distinctNames([...declared, ...heldDatabaseInstances(sandbox)], configured)
    .filter((name) => !isDefaultDatabaseInstance(name, projectId));
  const known: KnownDatabaseInstances = {
    named,
    pending: targets.pending.map(
      (target) => `${target.label} target "${target.target}" selects no instance yet: ${target.reason}.`,
    ),
  };
  if (defaultInstance !== undefined) {
    known.defaultInstance = defaultInstance;
  }
  return databaseInstanceCatalog(known, projectId);
}
