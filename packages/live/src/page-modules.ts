/**
 * The source of the modules a page gets for the live rows (`LIVE_ROWS`).
 * `@pyric/cli` fixes their ids and loads this file from the `@pyric/live`
 * installed in the project (its `./page-modules` export), so the rows open
 * only where this package is installed. The row and observer sources are
 * every plane's (`row-source.ts`); a page imports this package's files by
 * `/@fs` paths and the observer by its virtual specifier.
 *
 * Every live module hands its records to one observer module, which sends
 * them to the Node host on the page's own connection. It also exports the
 * refusal the host in the dev server gives pyric's own writes
 * (`liveWriteRefusal`).
 */
import { fileURLToPath } from 'node:url';
import {
  OBSERVER_MODULE_ID,
  OBSERVER_SPECIFIER,
  ROW_MODULE_IDS,
  type ServedFirebaseSpecifier,
} from '@pyric/cli/vite/internal/supplied-rows';
import { LIVE_ROWS } from './rows.js';
export { liveWriteRefusal } from './refusal.js';
import { observerModuleSource, rowModuleSource, type RowImports } from './row-source.js';

/** The live row a module id serves, or undefined for any other id. */
function rowOf(id: string): ServedFirebaseSpecifier | undefined {
  for (const [specifier, rowId] of ROW_MODULE_IDS) {
    const isRow = rowId === id && LIVE_ROWS.has(specifier);
    if (isRow) return specifier;
  }
  return undefined;
}

/**
 * The extension of this package's modules beside this one: `.js` in the
 * built files a project installs, `.ts` in the workspace source.
 */
const MODULE_EXTENSION = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

/** A module of this package, as the URL a page module imports it by. */
function servedFile(name: string): string {
  return `/@fs${fileURLToPath(new URL(`./${name}${MODULE_EXTENSION}`, import.meta.url))}`;
}

const PAGE_IMPORTS: RowImports = { file: servedFile, observer: OBSERVER_SPECIFIER, client: 'page' };

/** The project the host serves, as the plugin resolved it; unset until it does. */
let hostProjectId: string | undefined;

/**
 * Hands every row this plane serves from now on the project the host serves
 * (the plugin calls it once it has resolved the project), so each row refuses a
 * call whose app names another project.
 */
export function serveHostProject(projectId: string): void {
  hostProjectId = projectId;
}

/** How the observer module imports, with the host's project once it is known. */
function observerImports(projectId: string | undefined = hostProjectId): RowImports {
  if (projectId === undefined) return PAGE_IMPORTS;
  return { ...PAGE_IMPORTS, hostProjectId: projectId };
}

/**
 * Stamps `projectId` onto an observer module's source so concurrent `pyricLive`
 * plugin instances in one process never overwrite each other's `hostProjectId`.
 */
export function withObserverProject(source: string, projectId: string): string {
  const field = `hostProjectId: ${JSON.stringify(projectId)}`;
  if (/hostProjectId:\s*"(?:\\.|[^"\\])*"/.test(source)) {
    return source.replace(/hostProjectId:\s*"(?:\\.|[^"\\])*"/, field);
  }
  return source.replace(/,\s*client:\s*"page"\s*\}/, `, ${field}, client: "page" }`);
}

/**
 * The source of a module this plugin serves, or null for any other id.
 * `senderFile` is `@pyric/cli`'s observed-call sender, on disk.
 */
export function liveModuleSource(id: string, senderFile: string, projectId?: string): string | null {
  if (id === OBSERVER_MODULE_ID) return observerModuleSource(`/@fs${senderFile}`, observerImports(projectId ?? hostProjectId));
  const specifier = rowOf(id);
  return specifier === undefined ? null : rowModuleSource(specifier, PAGE_IMPORTS);
}
