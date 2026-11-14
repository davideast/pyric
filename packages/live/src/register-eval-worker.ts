/**
 * Synchronous preload for CommonJS `new Worker(code, { eval: true })` threads
 * spawned under `@pyric/live/register`. Avoids top-level `await` so CJS
 * `require(...)` succeeds on Node >= 22.15 while installing the identical
 * live-row hooks, Admin project gate, and worker/child-process guards from
 * this installed `@pyric/live` package.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_PASS_THROUGH_VARIABLE,
  LIVE_PROJECT_ROOT_VARIABLE,
  LIVE_SDK_ROOT_VARIABLE,
  activateWithSuppliedRowsSync,
  liveAppDirs,
  liveProjectId,
  noteSuppliedProcessProject,
  pinInheritedVariables,
  recordedPassThrough,
} from '@pyric/cli/register/internal/supplied-rows';
import { configuredDatabaseInstances } from './admin/database-instances.js';
import {
  LIVE_PINNED_PROJECT_VARIABLE,
  adminEnvRefusal,
  pinnedLiveProjectId,
} from './admin/project-gate.js';
import { refuseAdminWithoutHostProject, serveHostProject } from './node-modules.js';
import { ADMIN_PASS_THROUGH, adminRowsNodeProblem } from './refusal.js';
import { installedAdminVersion } from './start-checks.js';

const ENTRY = '@pyric/live/register';
const LIVE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function resolveWorkerProject(projectRoot: string, ignoreEnvProject: boolean): string | undefined {
  const pinned = pinnedLiveProjectId(process.env);
  if (pinned !== undefined) return pinned;
  const previousPyricProject = process.env.PYRIC_PROJECT;
  if (ignoreEnvProject) delete process.env.PYRIC_PROJECT;
  try {
    return liveProjectId(projectRoot);
  } catch {
    return undefined;
  } finally {
    if (ignoreEnvProject && previousPyricProject !== undefined) {
      process.env.PYRIC_PROJECT = previousPyricProject;
    }
  }
}

const isFirstProcess = process.env[LIVE_PROJECT_ROOT_VARIABLE] === undefined;
const inheritsAdmin = !isFirstProcess && recordedPassThrough(process.env).includes(ADMIN_PASS_THROUGH);
const adminNodeProblem = adminRowsNodeProblem();
const adminRows = adminNodeProblem === null;
const passThrough = isFirstProcess && adminRows ? [ADMIN_PASS_THROUGH] : undefined;
const installed = activateWithSuppliedRowsSync({ liveRoot: LIVE_ROOT, passThrough, adminRows });
if (installed !== null) {
  const servedProject = resolveWorkerProject(installed.projectRoot, !isFirstProcess);
  if (servedProject !== undefined) {
    const appDirs = liveAppDirs(undefined, process.cwd());
    const hasAdmin =
      inheritsAdmin || installedAdminVersion(appDirs, installed.projectRoot) !== null;
    if (hasAdmin && adminRows) {
      const envRefusal = adminEnvRefusal(process.env, servedProject);
      if (envRefusal !== null) throw envRefusal;
    }
    pinInheritedVariables({
      [LIVE_PROJECT_ROOT_VARIABLE]: installed.projectRoot,
      [LIVE_SDK_ROOT_VARIABLE]: process.env[LIVE_SDK_ROOT_VARIABLE] ?? installed.sdkRoot,
      [LIVE_PASS_THROUGH_VARIABLE]: process.env[LIVE_PASS_THROUGH_VARIABLE] ?? '',
      [LIVE_PINNED_PROJECT_VARIABLE]: servedProject,
      PYRIC_PROJECT: servedProject,
    });
    noteSuppliedProcessProject(servedProject);
    if ((process.env.GOOGLE_CLOUD_PROJECT ?? '') === '') {
      process.env.GOOGLE_CLOUD_PROJECT = servedProject;
    }
    const dbInstances = configuredDatabaseInstances(installed.projectRoot, servedProject);
    serveHostProject(servedProject, dbInstances);
    installed.serveHostProject?.(servedProject, dbInstances);
  } else {
    refuseAdminWithoutHostProject(installed.projectRoot);
    installed.refuseAdminWithoutHostProject?.(installed.projectRoot);
  }
  if (!isFirstProcess && inheritsAdmin && adminNodeProblem !== null) {
    process.stderr.write(`${ENTRY}: firebase-admin is refused in this process. ${adminNodeProblem}\n`);
  }
}
