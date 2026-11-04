/**
 * The installed `@pyric/live` the Node register's live rows open with
 * (`supplied-rows.ts`). It is found from the project root, the working
 * directory the process starts in, and it opens the rows only when its own
 * register entry is the module asking: `@pyric/live/register` must resolve,
 * from the project root, to the file that calls the seam. Not finding it is
 * an error: the register refuses to start, and the stop stays shut.
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LIVE_PACKAGE, installedLiveFile, liveNotInstalled, loadInstalledLiveExport } from '../serve/installed-live-package.js';
import type { RegisterRowPackage } from './supplied-rows.js';

/** The `@pyric/live` exports the register reads. */
const NODE_MODULES_SUBPATH = 'node-modules';
const REGISTER_SUBPATH = 'register';
const NOT_STARTED = 'The register did not start, so no firebase/* import loads the installed SDK.';

type ModuleSource = (url: string, senderUrl: string) => string | null;

/** The file the live rows' observer imports `sendObservedCall` from. */
function observedCallSenderUrl(): string {
  return new URL('./observed-call-sender.js', import.meta.url).href;
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/** Throws unless the installed `@pyric/live/register` is the file at `entryUrl`. */
function assertRunningEntry(projectRoot: string, entryUrl: string): void {
  const installed = installedLiveFile(projectRoot, REGISTER_SUBPATH);
  if (installed === null) throw liveNotInstalled(projectRoot, NOT_STARTED);
  const isEntryFile = entryUrl.startsWith('file:');
  const isRunningEntry = isEntryFile && samePath(installed, fileURLToPath(entryUrl));
  if (isRunningEntry) return;
  throw new Error(
    `pyric: live rows open only for ${LIVE_PACKAGE}/register as the project installs it (${installed}), ` +
      `and ${entryUrl} asked for them. ${NOT_STARTED}`,
  );
}

/** Loads the installed `@pyric/live` for the register at `entryUrl`. Throws when it is not installed or not that entry. */
export async function loadRegisterRowPackage(projectRoot: string, entryUrl: string): Promise<RegisterRowPackage> {
  assertRunningEntry(projectRoot, entryUrl);
  const found = await loadInstalledLiveExport(projectRoot, NODE_MODULES_SUBPATH, 'liveRegisterModuleSource', NOT_STARTED);
  const source = found.fn as unknown as ModuleSource;
  const senderUrl = observedCallSenderUrl();
  return {
    projectUrl: pathToFileURL(join(projectRoot, 'package.json')).href,
    moduleSource: (url) => source(url, senderUrl),
  };
}
