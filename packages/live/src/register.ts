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
 * `firebase-admin`, is refused (`refusal.ts`), unless the live host passes
 * it through: a process passes through the imports its host lists in
 * `pyricLive({ passThrough })`, which the host's `/__pyric/health` reports.
 * Each is then the app's installed SDK, unwrapped and unobserved, and the
 * start line says so. One list serves the page and the server, so the health
 * report, the chip and every process agree on it.
 *
 * It is `@pyric/cli`'s register hooks with the live rows, through the one
 * internal seam. The seam takes only this package's folder and the
 * pass-through list from this file: it opens the rows only when
 * `@pyric/live` is installed, and loads the row modules' source and the
 * refusal from that installed package (`node-modules.ts`): the copy this
 * file is part of, which may be installed beside the app rather than in it,
 * or else the one the project root resolves.
 *
 * The first process runs the start checks (`start-checks.ts`), prints the
 * start line, and says which host its calls reach, or how to start one. A
 * child process or worker it starts opens the same rows, with the same
 * pass-through imports, quietly.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_PROJECT_ROOT_VARIABLE,
  activateWithSuppliedRows,
  liveAppDirs,
  livePassThroughLine,
  liveProjectId,
  liveProjectRoot,
  reachLiveHost,
} from '@pyric/cli/register/internal/supplied-rows';
import { passThroughOption } from './refusal.js';
import { hostReachLine, liveStartLine } from './start-line.js';
import { liveStartRefusal } from './start-checks.js';

const ENTRY = '@pyric/live/register';

/** This package's folder: the one above `dist/` in the installed files, or above `src/` in the workspace. */
const LIVE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const isFirstProcess = process.env[LIVE_PROJECT_ROOT_VARIABLE] === undefined;
// The first process asks its host what passes through before any hook goes in;
// a child or worker passes through what its first process recorded.
const reach = isFirstProcess ? await reachLiveHost(liveProjectRoot(process.env, process.cwd())) : null;
const hostPassThrough = reach?.kind === 'live' ? reach.passThrough : [];
const passThrough = isFirstProcess ? passThroughOption(ENTRY, hostPassThrough) : undefined;
await activateWithSuppliedRows({ liveRoot: LIVE_ROOT, passThrough });
// The seam records the project root only when the rows opened.
const projectRoot = process.env[LIVE_PROJECT_ROOT_VARIABLE];
const startsLive = reach !== null && projectRoot !== undefined;
if (startsLive) {
  // The app's firebase as its rows read it: from the entry script's folder, then the working directory.
  const refusal = liveStartRefusal(projectRoot, liveAppDirs(process.argv[1], process.cwd()));
  if (refusal !== null) throw new Error(`${ENTRY}: ${refusal}`);
  const projectId = liveProjectId(projectRoot);
  const passing = (passThrough ?? []).map((specifier) => `${ENTRY}: ${livePassThroughLine(specifier)}`);
  const lines = [liveStartLine(ENTRY, projectId), ...passing, hostReachLine(ENTRY, reach, projectId, projectRoot)];
  process.stderr.write(`${lines.join('\n')}\n`);
}
