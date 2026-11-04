/**
 * The `@pyric/live` installed in a project, found from the project root.
 * Both planes that serve live rows read it: the Vite page plane
 * (`vite-live-package.ts`) and the Node register (`../register/live-package.ts`).
 * Each takes its row modules' source from one export of it, so the rows open
 * only in a project that has the package installed.
 *
 * Imports node built-ins only, so the register can load it without Vite.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIVE_PACKAGE = '@pyric/live';

/** Where `@pyric/live/<subpath>` resolves from the project root, or null when it is not installed. */
export function installedLiveFile(projectRoot: string, subpath: string): string | null {
  try {
    return createRequire(join(projectRoot, 'package.json')).resolve(`${LIVE_PACKAGE}/${subpath}`);
  } catch {
    return null;
  }
}

/** The package folder holding `file`: the nearest folder above it with a package.json. */
export function packageRootOf(file: string): string {
  let dir = dirname(file);
  while (dir !== dirname(dir) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return dir;
}

/** The error for a project without `@pyric/live`; `consequence` says what stays shut. */
export function liveNotInstalled(projectRoot: string, consequence: string): Error {
  return new Error(
    `pyric: live rows need ${LIVE_PACKAGE} installed in the project, and it does not resolve from ${projectRoot}. ${consequence}`,
  );
}

/**
 * The function `name` that the installed `@pyric/live/<subpath>` exports, and
 * the package folder it came from. Throws when the package is not installed
 * or the export is missing.
 */
export async function loadInstalledLiveExport(
  projectRoot: string,
  subpath: string,
  name: string,
  consequence: string,
): Promise<{ readonly root: string; readonly file: string; readonly fn: (...args: never[]) => unknown }> {
  const file = installedLiveFile(projectRoot, subpath);
  if (file === null) throw liveNotInstalled(projectRoot, consequence);
  const loaded = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const fn = loaded[name];
  if (typeof fn !== 'function') throw new Error(`pyric: ${LIVE_PACKAGE}/${subpath} does not export ${name}.`);
  return { root: packageRootOf(file), file, fn: fn as (...args: never[]) => unknown };
}
