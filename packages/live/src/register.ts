/**
 * `@pyric/live/register`: live mode for a Node process.
 *
 *   node --import @pyric/live/register server.js
 *
 * The process's `firebase/app`, `firebase/auth`, `firebase/firestore` and
 * `firebase/app-check` are the app's own installed SDK, wrapped by the live
 * rows, so the app talks to its real project. Each wrapped Firestore and
 * Auth call's outcome reaches the Node host (`pyric-live`, or a Vite dev
 * server with `pyricLive()`) as an observed call, and the chip shows it as
 * production's row from a server process. Every other Firebase import, and
 * `firebase-admin`, is refused (`refusal.ts`).
 *
 * It is `@pyric/cli`'s register hooks with the live rows, through the one
 * internal seam. The seam takes nothing from this file: it opens the rows
 * only when `@pyric/live` is installed in the project, and loads the row
 * modules' source and the refusal from that installed package
 * (`node-modules.ts`).
 *
 * The first process runs the start checks (`start-checks.ts`), prints the
 * start line, and says which host its calls reach, or how to start one. A
 * child process or worker it starts opens the same rows quietly.
 */
import {
  LIVE_PROJECT_ROOT_VARIABLE,
  activateWithSuppliedRows,
  liveProjectId,
  reachLiveHost,
} from '@pyric/cli/register/internal/supplied-rows';
import { hostReachLine, liveStartLine } from './start-line.js';
import { liveStartRefusal } from './start-checks.js';

const ENTRY = '@pyric/live/register';

const isFirstProcess = process.env[LIVE_PROJECT_ROOT_VARIABLE] === undefined;
await activateWithSuppliedRows();
// The seam records the project root only when the rows opened.
const projectRoot = process.env[LIVE_PROJECT_ROOT_VARIABLE];
const startsLive = isFirstProcess && projectRoot !== undefined;
if (startsLive) {
  const refusal = liveStartRefusal(projectRoot);
  if (refusal !== null) throw new Error(`${ENTRY}: ${refusal}`);
  const projectId = liveProjectId(projectRoot);
  process.stderr.write(`${liveStartLine(ENTRY, projectId)}\n`);
  process.stderr.write(`${hostReachLine(ENTRY, await reachLiveHost(projectRoot), projectId, projectRoot)}\n`);
}
