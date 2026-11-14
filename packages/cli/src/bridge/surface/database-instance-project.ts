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
import {
  resolveFirebaseProject,
  type FirebaseProjectResolution,
} from '../../cli/firebase-project.js';
import { readPyricConfigProjectSync } from '../../serve/live-project.js';
import { databaseRulesTargets, type DatabaseRulesTargets } from '../../serve/rules.js';
import {
  databaseInstanceCatalog,
  distinctNames,
  type DatabaseInstanceCatalog,
  type KnownDatabaseInstances,
} from './database-instance-catalog.js';

async function loadProjectDatabaseTargets(
  projectDir: string,
  projectOverride?: FirebaseProjectResolution,
): Promise<{
  project: FirebaseProjectResolution;
  targets: DatabaseRulesTargets;
  configuredDefaultInstance: string | undefined;
}> {
  let config: FirebaseJson | null = null;
  if (existsSync(join(projectDir, 'firebase.json'))) {
    config = await readFirebaseJson(projectDir);
  }
  const project =
    projectOverride ??
    resolveFirebaseProject({
      projectDir,
      configProject: readPyricConfigProjectSync(projectDir),
    });
  const targets = databaseRulesTargets(projectDir, config, project);
  let configuredDefaultInstance: string | undefined;
  if (targets.defaultInstance !== UNNAMED_DEFAULT_DATABASE_INSTANCE) {
    configuredDefaultInstance = targets.defaultInstance;
  }
  return { project, targets, configuredDefaultInstance };
}

/** Resolve a project directory's Firebase project ID and configured default RTDB instance. */
export async function resolveProjectAndDefaultInstance(
  projectDir: string,
  projectOverride?: FirebaseProjectResolution,
): Promise<{ projectId: string; defaultInstance: string }> {
  const { project, configuredDefaultInstance } = await loadProjectDatabaseTargets(
    projectDir,
    projectOverride,
  );
  const projectId = project.projectId ?? 'demo-project';
  const defaultInstance = configuredDefaultInstance ?? `${projectId}-default-rtdb`;
  return { projectId, defaultInstance };
}

/** The catalog for a project directory: its `firebase.json`, its project, and what `sandbox` holds. */
export async function projectDatabaseInstances(
  sandbox: LocalSandbox,
  projectDir: string,
): Promise<DatabaseInstanceCatalog> {
  const { project, targets, configuredDefaultInstance } =
    await loadProjectDatabaseTargets(projectDir);
  const projectId = project.projectId;
  const declared = targets.targets.map((target) => target.instance);
  const named = distinctNames(
    [...declared, ...heldDatabaseInstances(sandbox)],
    targets.defaultInstance,
  ).filter((name) => !isDefaultDatabaseInstance(name, projectId));
  const known: KnownDatabaseInstances = {
    named,
    pending: targets.pending.map(
      (target) =>
        `${target.label} target "${target.target}" selects no instance yet: ${target.reason}.`,
    ),
  };
  if (configuredDefaultInstance !== undefined) {
    known.defaultInstance = configuredDefaultInstance;
  }
  return databaseInstanceCatalog(known, projectId);
}
