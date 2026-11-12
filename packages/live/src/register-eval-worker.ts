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
  LIVE_PROJECT_ROOT_VARIABLE,
  activateWithSuppliedRowsSync,
  liveProjectId,
  recordedPassThrough,
} from '@pyric/cli/register/internal/supplied-rows';
import { configuredDatabaseInstances } from './admin/database-instances.js';
import { refuseAdminWithoutHostProject, serveHostProject } from './node-modules.js';
import { ADMIN_PASS_THROUGH, adminRowsNodeProblem } from './refusal.js';

const ENTRY = '@pyric/live/register';
const LIVE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function resolveWorkerProject(projectRoot: string): string | undefined {
  try {
    return liveProjectId(projectRoot);
  } catch {
    return undefined;
  }
}

const isFirstProcess = process.env[LIVE_PROJECT_ROOT_VARIABLE] === undefined;
const inheritsAdmin = !isFirstProcess && recordedPassThrough(process.env).includes(ADMIN_PASS_THROUGH);
const adminNodeProblem = adminRowsNodeProblem();
const adminRows = adminNodeProblem === null;
const passThrough = isFirstProcess && adminRows ? [ADMIN_PASS_THROUGH] : undefined;
const installed = activateWithSuppliedRowsSync({ liveRoot: LIVE_ROOT, passThrough, adminRows });
if (installed !== null) {
  const servedProject = resolveWorkerProject(installed.projectRoot);
  if (servedProject !== undefined) {
    if ((process.env.GOOGLE_CLOUD_PROJECT ?? '') === '') {
      process.env.GOOGLE_CLOUD_PROJECT = servedProject;
    }
    serveHostProject(servedProject, configuredDatabaseInstances(installed.projectRoot, servedProject));
    installed.serveHostProject?.(
      servedProject,
      configuredDatabaseInstances(installed.projectRoot, servedProject),
    );
  } else {
    refuseAdminWithoutHostProject(installed.projectRoot);
    installed.refuseAdminWithoutHostProject?.(installed.projectRoot);
  }
  if (!isFirstProcess && inheritsAdmin && adminNodeProblem !== null) {
    process.stderr.write(`${ENTRY}: firebase-admin is refused in this process. ${adminNodeProblem}\n`);
  }
}
