/**
 * The source of the modules a page gets for the four live rows. `@pyric/cli`
 * fixes their ids and loads this file from the `@pyric/live` installed in
 * the project (its `./page-modules` export), so the rows open only where
 * this package is installed. The row and observer sources are every plane's
 * (`row-source.ts`); a page imports this package's files by `/@fs` paths and
 * the observer by its virtual specifier.
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

/** A module of this package, as the URL a page module imports it by. */
function servedFile(name: string): string {
  return `/@fs${fileURLToPath(new URL(`./${name}.ts`, import.meta.url))}`;
}

const PAGE_IMPORTS: RowImports = { file: servedFile, observer: OBSERVER_SPECIFIER, client: 'page' };

/**
 * The source of a module this plugin serves, or null for any other id.
 * `senderFile` is `@pyric/cli`'s observed-call sender, on disk.
 */
export function liveModuleSource(id: string, senderFile: string): string | null {
  if (id === OBSERVER_MODULE_ID) return observerModuleSource(`/@fs${senderFile}`, PAGE_IMPORTS);
  const specifier = rowOf(id);
  return specifier === undefined ? null : rowModuleSource(specifier, PAGE_IMPORTS);
}
