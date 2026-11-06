/**
 * The installed `@pyric/live`: the one the supplier of the rows was loaded
 * from, when it says where that is, or else the one the project root
 * resolves. The live rows' modules (`vite-supplied-rows.ts`) take their
 * source from it, so the rows open only in a project that has the package
 * installed, and the host takes its refusal of pyric's own writes from it
 * (`hosted/own-writes.ts`). Not finding it is an error: the plugin refuses to
 * start, and the stop stays shut.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createViteModuleContext } from './vite-module-swap.js';
import { installedLiveFile, loadInstalledLiveExport } from './installed-live-package.js';
import type { PyricWriteRefusal } from './hosted/own-writes.js';

/** The `@pyric/live` export that builds a row module's source and gives the host's write refusal. */
const PAGE_MODULES_SUBPATH = 'page-modules';
const NOT_OPENED = 'Every served firebase/* import stays on the sandbox stop.';

/** What the plugin reads from the installed `@pyric/live`. */
export interface RowModulePackage {
  /** The package's folder, which the page loads the row modules' imports from. */
  readonly root: string;
  /** The source of a fixed live module id, or null for any other id. */
  moduleSource(id: string): string | null;
  /** The error the host gives for one of pyric's own writes, in live mode (`hosted/own-writes.ts`). */
  readonly writeRefusal: PyricWriteRefusal;
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

/**
 * Where the package resolves from: `liveRoot`, the folder of the
 * `@pyric/live` that supplied the rows, when the package resolves there, or
 * else the project root, whose refusal names it.
 */
function resolutionRoot(projectRoot: string, liveRoot: string | undefined): string {
  const resolvesFromLiveRoot = liveRoot !== undefined && installedLiveFile(liveRoot, PAGE_MODULES_SUBPATH) !== null;
  return resolvesFromLiveRoot ? liveRoot : projectRoot;
}

/**
 * Loads the installed `@pyric/live`, from `liveRoot` first and then from the
 * project root. Throws when neither has it.
 */
export async function loadRowModulePackage(projectRoot: string, liveRoot?: string): Promise<RowModulePackage> {
  const from = resolutionRoot(projectRoot, liveRoot);
  const found = await loadInstalledLiveExport(from, PAGE_MODULES_SUBPATH, 'liveModuleSource', NOT_OPENED);
  const refusals = await loadInstalledLiveExport(from, PAGE_MODULES_SUBPATH, 'liveWriteRefusal', NOT_OPENED);
  const source = found.fn as unknown as ModuleSource;
  const senderFile = observedCallSenderEntry();
  return {
    root: found.root,
    moduleSource: (id) => source(id, senderFile),
    writeRefusal: refusals.fn as unknown as PyricWriteRefusal,
  };
}
