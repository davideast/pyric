/**
 * The installed `@pyric/live`, found from the project root. The live rows'
 * modules (`vite-supplied-rows.ts`) take their source from it, so the rows
 * open only in a project that has the package installed. Not finding it is
 * an error: the plugin refuses to start, and the stop stays shut.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createViteModuleContext } from './vite-module-swap.js';
import { loadInstalledLiveExport } from './installed-live-package.js';

/** The `@pyric/live` export that builds a row module's source. */
const PAGE_MODULES_SUBPATH = 'page-modules';

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

/** Loads the installed `@pyric/live` from the project root. Throws when it is not installed. */
export async function loadRowModulePackage(projectRoot: string): Promise<RowModulePackage> {
  const found = await loadInstalledLiveExport(
    projectRoot,
    PAGE_MODULES_SUBPATH,
    'liveModuleSource',
    'Every served firebase/* import stays on the sandbox stop.',
  );
  const source = found.fn as unknown as ModuleSource;
  const senderFile = observedCallSenderEntry();
  return {
    root: found.root,
    moduleSource: (id) => source(id, senderFile),
  };
}
