/**
 * The installed `@pyric/live`, found from the project root. The live rows'
 * modules (`vite-supplied-rows.ts`) take their source from it, so the rows
 * open only in a project that has the package installed. Not finding it is
 * an error: the plugin refuses to start, and the stop stays shut.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createViteModuleContext } from './vite-module-swap.js';

const LIVE_PACKAGE = '@pyric/live';
/** The `@pyric/live` export that builds a row module's source. */
const PAGE_MODULES_EXPORT = `${LIVE_PACKAGE}/page-modules`;

/** What the plugin reads from the installed `@pyric/live`. */
export interface RowModulePackage {
  /** The package's folder, which the page loads the row modules' imports from. */
  readonly root: string;
  /** The source of a fixed live module id, or null for any other id. */
  moduleSource(id: string): string | null;
}

type ModuleSource = (id: string, senderFile: string) => string | null;

/**
 * The file a row module's observer imports `sendObservedCall` from. It sits
 * beside the served entries, so it shares the page runtime's connection.
 */
export function observedCallSenderEntry(): string {
  const entriesDir = dirname(createViteModuleContext().entries.init);
  const js = join(entriesDir, 'observed-call-sender.js');
  return existsSync(js) ? js : join(entriesDir, 'observed-call-sender.ts');
}

function notInstalled(projectRoot: string): Error {
  return new Error(
    `pyric: live rows need ${LIVE_PACKAGE} installed in the project, and it does not resolve from ${projectRoot}. ` +
      'Every served firebase/* import stays on the sandbox stop.',
  );
}

/** Where `@pyric/live`'s page-modules export resolves from the project root, or null when it is not installed. */
function pageModulesFile(projectRoot: string): string | null {
  try {
    return createRequire(join(projectRoot, 'package.json')).resolve(PAGE_MODULES_EXPORT);
  } catch {
    return null;
  }
}

/** The package folder holding `file`: the nearest folder above it with a package.json. */
function packageRootOf(file: string): string {
  let dir = dirname(file);
  while (dir !== dirname(dir) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return dir;
}

/** Loads the installed `@pyric/live` from the project root. Throws when it is not installed. */
export async function loadRowModulePackage(projectRoot: string): Promise<RowModulePackage> {
  const file = pageModulesFile(projectRoot);
  if (file === null) throw notInstalled(projectRoot);
  const loaded = (await import(pathToFileURL(file).href)) as { liveModuleSource?: unknown };
  const source = loaded.liveModuleSource;
  if (typeof source !== 'function') throw new Error(`pyric: ${PAGE_MODULES_EXPORT} does not export liveModuleSource.`);
  const senderFile = observedCallSenderEntry();
  return {
    root: packageRootOf(file),
    moduleSource: (id) => (source as ModuleSource)(id, senderFile),
  };
}
