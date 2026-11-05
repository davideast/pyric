/**
 * The installed `@pyric/live` the Node register's live rows open with
 * (`supplied-rows.ts`): the one the register entry was loaded from, when it
 * says where that is and the package resolves there, or else the one the
 * project root resolves, as the Vite plane finds it (`../serve/vite-live-package.ts`).
 * So the register opens when `@pyric/live` is installed in a package beside
 * the app rather than in it. The row modules' source, the refusal and the
 * register entry that child processes and workers load all come from that
 * installed package. Not finding it is an error: the register refuses to
 * start, and the stop stays shut.
 *
 * The project root is resolved once, in the first process: the nearest
 * folder from the working directory up that holds `.firebaserc` or
 * `firebase.json` (`findFirebaseProjectDir`, as the Vite plugin finds its
 * project), or the working directory when none does. That process records the root in
 * `PYRIC_LIVE_PROJECT_ROOT`, which the child-process guard copies to every
 * child, so a child started in another directory opens the same project's
 * rows. The variable only names where to look: the directory it names must
 * still hold an installed `@pyric/live`, and a process turns live mode on
 * only by importing `@pyric/live/register`.
 *
 * The first process records the imports it passes through the same way, in
 * `PYRIC_LIVE_PASS_THROUGH`, so its children and workers pass the same ones
 * through. The list is checked again wherever it is read.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findFirebaseProjectDir } from '../cli/firebase-project.js';
import { installedLiveFile, liveNotInstalled, loadInstalledLiveExport } from '../serve/installed-live-package.js';
import type { SuppliedRowsRefusal } from '../serve/vite-supplied-rows.js';
import type { RegisterRowPackage } from './supplied-rows.js';

/** The `@pyric/live` exports the register reads. */
const NODE_MODULES_SUBPATH = 'node-modules';
const REGISTER_SUBPATH = 'register';
const NOT_STARTED = 'The register did not start, so no firebase/* import loads the installed SDK.';

/** The internal variable that carries the first process's project root to its children. */
export const LIVE_PROJECT_ROOT_VARIABLE = 'PYRIC_LIVE_PROJECT_ROOT';

/** The internal variable that carries the first process's pass-through imports to its children, comma-separated. */
export const LIVE_PASS_THROUGH_VARIABLE = 'PYRIC_LIVE_PASS_THROUGH';

/** The pass-through imports the first process recorded, or none. */
export function recordedPassThrough(env: Record<string, string | undefined>): string[] {
  const recorded = env[LIVE_PASS_THROUGH_VARIABLE] ?? '';
  return recorded === '' ? [] : recorded.split(',');
}

type ModuleSource = (url: string, senderUrl: string) => string | null;
type SdkRoot = (appDir: string, projectRoot: string) => string;

/** What the register opens with: the installed rows, and the register entry children load. */
export interface InstalledLiveRegister {
  readonly rows: RegisterRowPackage;
  /** The installed `@pyric/live/register`, by file URL. */
  readonly entryUrl: string;
  readonly projectRoot: string;
}

/** The file the live rows' observer imports `sendObservedCall` from. */
function observedCallSenderUrl(): string {
  return new URL('./observed-call-sender.js', import.meta.url).href;
}

/**
 * The project root: the one the first process recorded, or else the Firebase
 * project folder at or above `cwd`, or `cwd` itself when there is none, so a
 * start with no project names the folder it started from.
 */
export function liveProjectRoot(env: Record<string, string | undefined>, cwd: string): string {
  const recorded = env[LIVE_PROJECT_ROOT_VARIABLE];
  const hasRecorded = recorded !== undefined && recorded !== '';
  if (hasRecorded) return recorded;
  return findFirebaseProjectDir(cwd) ?? cwd;
}

/**
 * Where the package resolves from: `liveRoot`, the folder of the
 * `@pyric/live` whose register entry is running, when the package resolves
 * there, or else the project root, whose refusal names it.
 */
export function liveResolutionRoot(projectRoot: string, liveRoot: string | undefined): string {
  const resolvesFromLiveRoot = liveRoot !== undefined && installedLiveFile(liveRoot, REGISTER_SUBPATH) !== null;
  return resolvesFromLiveRoot ? liveRoot : projectRoot;
}

/**
 * Loads the installed `@pyric/live`, from `liveRoot` first and then from
 * `projectRoot`. Throws when neither has it. The rows resolve the app's SDK
 * from the folder that package's start checks read it from
 * (`liveRegisterSdkRoot`, `appFirebaseRoot` in its `start-checks.ts`):
 * `appDir`, the folder the process runs in, when `firebase` resolves there,
 * else `projectRoot`. One function in one package picks it, so the check and
 * the rows never read two copies of `firebase`.
 */
export async function loadInstalledLiveRegister(
  projectRoot: string,
  liveRoot?: string,
  appDir: string = process.cwd(),
): Promise<InstalledLiveRegister> {
  const from = liveResolutionRoot(projectRoot, liveRoot);
  const entry = installedLiveFile(from, REGISTER_SUBPATH);
  if (entry === null) throw liveNotInstalled(projectRoot, NOT_STARTED);
  const sources = await loadInstalledLiveExport(from, NODE_MODULES_SUBPATH, 'liveRegisterModuleSource', NOT_STARTED);
  const refusals = await loadInstalledLiveExport(from, NODE_MODULES_SUBPATH, 'liveRefusal', NOT_STARTED);
  const sdkRoots = await loadInstalledLiveExport(from, NODE_MODULES_SUBPATH, 'liveRegisterSdkRoot', NOT_STARTED);
  const source = sources.fn as unknown as ModuleSource;
  const sdkRoot = (sdkRoots.fn as unknown as SdkRoot)(appDir, projectRoot);
  const senderUrl = observedCallSenderUrl();
  const rows: RegisterRowPackage = {
    projectUrl: pathToFileURL(join(sdkRoot, 'package.json')).href,
    refusal: refusals.fn as unknown as SuppliedRowsRefusal,
    moduleSource: (url) => source(url, senderUrl),
  };
  return { rows, entryUrl: pathToFileURL(entry).href, projectRoot };
}
