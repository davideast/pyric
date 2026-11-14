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
  adminEnvRefusal,
  buildPinnedLiveEnvMap,
  resolveInheritedLiveProject,
} from './admin/project-gate.js';
import { refuseAdminWithoutHostProject, serveHostProject } from './node-modules.js';
import { ADMIN_PASS_THROUGH, adminRowsNodeProblem } from './refusal.js';
import { installedAdminVersion } from './start-checks.js';

const ENTRY = '@pyric/live/register';
const LIVE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PIN_KEYS = {
  projectRootVar: LIVE_PROJECT_ROOT_VARIABLE,
  sdkRootVar: LIVE_SDK_ROOT_VARIABLE,
  passThroughVar: LIVE_PASS_THROUGH_VARIABLE,
} as const;

const isFirstProcess = process.env[LIVE_PROJECT_ROOT_VARIABLE] === undefined;
const inheritsAdmin = !isFirstProcess && recordedPassThrough(process.env).includes(ADMIN_PASS_THROUGH);
const adminNodeProblem = adminRowsNodeProblem();
const adminRows = adminNodeProblem === null;
const passThrough = isFirstProcess && adminRows ? [ADMIN_PASS_THROUGH] : undefined;
const installed = activateWithSuppliedRowsSync({ liveRoot: LIVE_ROOT, passThrough, adminRows });
if (installed !== null) {
  const servedProject = resolveInheritedLiveProject(installed.projectRoot, !isFirstProcess, liveProjectId);
  if (servedProject !== undefined) {
    const appDirs = liveAppDirs(undefined, process.cwd());
    const hasAdmin =
      inheritsAdmin || installedAdminVersion(appDirs, installed.projectRoot) !== null;
    if (hasAdmin && adminRows) {
      const envRefusal = adminEnvRefusal(process.env, servedProject);
      if (envRefusal !== null) throw envRefusal;
    }
    pinInheritedVariables(
      buildPinnedLiveEnvMap(PIN_KEYS, installed.projectRoot, installed.sdkRoot, servedProject),
    );
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
