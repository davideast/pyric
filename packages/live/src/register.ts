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
 * production's row from a server process. `firebase-admin` loads with the
 * app's own credential through the Admin rows, which observe its Firestore,
 * Auth, Realtime Database and Storage calls for the host's project; the
 * start line says those calls bypass Security Rules, and the register sets
 * `GOOGLE_CLOUD_PROJECT` to the host's project when it is unset. Every other
 * Firebase import is refused (`refusal.ts`), unless the live host passes
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
 * pass-through imports, quietly. Every process hands its rows the project it
 * resolved (`serveHostProject`), so a call whose app names another project
 * is refused.
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
import { serveHostProject } from './node-modules.js';
import { ADMIN_PASS_THROUGH, adminRowsNodeProblem, passThroughOption } from './refusal.js';
import { hostReachLine, liveStartLine, passThroughLines } from './start-line.js';
import { adminStartRefusal, installedAdminVersion, liveStartRefusal } from './start-checks.js';
import { adminEnvRefusal } from './admin/project-gate.js';

const ENTRY = '@pyric/live/register';

/**
 * The project a child process or worker serves: the one its first process
 * resolved, from the project root that process recorded. A root with no
 * project serves none, so no call is refused by project, as before.
 */
function childProject(projectRoot: string): string | undefined {
  try {
    return liveProjectId(projectRoot);
  } catch {
    return undefined;
  }
}

/** This package's folder: the one above `dist/` in the installed files, or above `src/` in the workspace. */
const LIVE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The Admin start line: firebase-admin is observed, with its own credential,
 * and its calls bypass Security Rules. Then one line per Admin emulator
 * variable that is set, naming where those calls go instead.
 */
function adminLines(projectId: string, env: NodeJS.ProcessEnv): string[] {
  if (adminNodeProblem !== null) return [`${ENTRY}: firebase-admin is refused in this process. ${adminNodeProblem}`];
  const observed =
    `${ENTRY}: firebase-admin is observed for the Firebase project ${projectId}. ` +
    'This process uses its own credential, and its Admin calls bypass Security Rules.';
  const redirected = ADMIN_EMULATOR_VARIABLES.filter(([variable]) => (env[variable] ?? '') !== '').map(
    ([variable, service]) => `${ENTRY}: ${variable} is set, so firebase-admin's ${service} calls go to ${env[variable]}, not to production.`,
  );
  return [observed, ...redirected];
}

/** The emulator variables firebase-admin reads, and the service each sends elsewhere. */
const ADMIN_EMULATOR_VARIABLES: readonly (readonly [string, string])[] = [
  ['FIRESTORE_EMULATOR_HOST', 'Firestore'],
  ['FIREBASE_AUTH_EMULATOR_HOST', 'Auth'],
  ['FIREBASE_DATABASE_EMULATOR_HOST', 'Realtime Database'],
  ['FIREBASE_STORAGE_EMULATOR_HOST', 'Storage'],
  ['STORAGE_EMULATOR_HOST', 'Storage'],
];

const isFirstProcess = process.env[LIVE_PROJECT_ROOT_VARIABLE] === undefined;
// The first process asks its host what passes through before any hook goes in;
// a child or worker passes through what its first process recorded.
const reach = isFirstProcess ? await reachLiveHost(liveProjectRoot(process.env, process.cwd())) : null;
// Live mode serves firebase-admin itself (D2 in the #2304 plan), so a host's Admin field adds nothing to the list.
const hostPassThrough = reach?.kind === 'live' ? reach.passThrough.filter((specifier) => specifier !== ADMIN_PASS_THROUGH) : [];
const passThrough = isFirstProcess ? passThroughOption(ENTRY, hostPassThrough) : undefined;
// The Admin rows are on from Node 23: firebase-admin loads through the seam's Admin tree, and its four
// class-defining loads get the rows. On Node 22 they stay shut, and every firebase-admin import is refused.
const adminNodeProblem = adminRowsNodeProblem();
const adminRows = adminNodeProblem === null;
const adminImport = adminRows ? [ADMIN_PASS_THROUGH] : [];
const seamPassThrough = passThrough === undefined ? undefined : [...passThrough, ...adminImport];
await activateWithSuppliedRows({ liveRoot: LIVE_ROOT, passThrough: seamPassThrough, adminRows });
// The seam records the project root only when the rows opened.
const projectRoot = process.env[LIVE_PROJECT_ROOT_VARIABLE];
const startsLive = reach !== null && projectRoot !== undefined;
const isChild = !isFirstProcess && projectRoot !== undefined;
const servedChildProject = isChild ? childProject(projectRoot) : undefined;
if (servedChildProject !== undefined) serveHostProject(servedChildProject);
if (startsLive) {
  // The app's firebase as its rows read it: from the entry script's folder, then the working directory.
  const appDirs = liveAppDirs(process.argv[1], process.cwd());
  const refusal = liveStartRefusal(projectRoot, appDirs) ?? adminStartRefusal(appDirs, projectRoot);
  if (refusal !== null) throw new Error(`${ENTRY}: ${refusal}`);
  const projectId = liveProjectId(projectRoot);
  const envRefusal = adminEnvRefusal(process.env, projectId);
  if (envRefusal !== null) throw envRefusal;
  // firebase-admin and @google-cloud/storage read the project from here when the app names none, as a functions child does.
  if ((process.env.GOOGLE_CLOUD_PROJECT ?? '') === '') process.env.GOOGLE_CLOUD_PROJECT = projectId;
  serveHostProject(projectId);
  const passing = passThroughLines(ENTRY, passThrough ?? [], livePassThroughLine);
  const hasAdmin = installedAdminVersion(appDirs, projectRoot) !== null;
  const admin = hasAdmin ? adminLines(projectId, process.env) : [];
  const lines = [liveStartLine(ENTRY, projectId), ...passing, ...admin, hostReachLine(ENTRY, reach, projectId, projectRoot)];
  process.stderr.write(`${lines.join('\n')}\n`);
}
