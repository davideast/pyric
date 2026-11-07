/**
 * The source of the modules a Node process gets for the live rows
 * (`LIVE_ROWS`). `@pyric/cli`'s register fixes their ids and loads this file
 * from the `@pyric/live` installed in the project (its `./node-modules`
 * export), so the rows open only where this package is installed. It also
 * exports the refusal those rows give, and the refusal of pyric's own
 * writes the `pyric-live` host gives (`refusal.ts`), and the folder the rows
 * resolve the app's `firebase` from (`start-checks.ts`). The row and
 * observer sources are every plane's (`row-source.ts`); a Node process
 * imports this package's built files and the observer module by file URL.
 *
 * Every live module hands its records to one observer module, which sends
 * them to the Node host on the process's own connection.
 *
 * It also answers the Admin row ids (`ADMIN_ROW_URLS`): CommonJS modules, as
 * the Admin SDK is, that each load the real module at one of the Admin SDK's
 * class-defining loads and export it as it is. The Admin rows' observers
 * (A-4 to A-7 in the #2304 plan) patch its classes here.
 */
import {
  ADMIN_ROW_LOADS,
  REGISTER_OBSERVER_URL,
  REGISTER_ROW_URLS,
  adminRowOfUrl,
  type ServedFirebaseSpecifier,
} from '@pyric/cli/register/internal/supplied-rows';
import { LIVE_ROWS } from './rows.js';
export { liveRefusal, liveWriteRefusal } from './refusal.js';
export { appFirebaseRoot as liveRegisterSdkRoot } from './start-checks.js';
import { observerModuleSource, rowModuleSource, type RowImports } from './row-source.js';

/** The live row a module id serves, or undefined for any other id. */
function rowOf(url: string): ServedFirebaseSpecifier | undefined {
  for (const [specifier, rowUrl] of REGISTER_ROW_URLS) {
    const isRow = rowUrl === url && LIVE_ROWS.has(specifier);
    if (isRow) return specifier;
  }
  return undefined;
}

/** A built module of this package, by file URL. */
function builtFile(name: string): string {
  return new URL(`./${name}.js`, import.meta.url).href;
}

const NODE_IMPORTS: RowImports = { file: builtFile, observer: REGISTER_OBSERVER_URL, client: 'node' };

/** The project the host serves, as the register resolved it; unset until it does. */
let hostProjectId: string | undefined;

/**
 * Hands every row this plane serves from now on the project the host serves
 * (the register calls it once it has resolved the project), so each row refuses a
 * call whose app names another project.
 */
export function serveHostProject(projectId: string): void {
  hostProjectId = projectId;
}

/** How the observer module imports, with the host's project once it is known. */
function observerImports(): RowImports {
  if (hostProjectId === undefined) return NODE_IMPORTS;
  return { ...NODE_IMPORTS, hostProjectId };
}

/** An Admin row's source: the real module at its load, required by its own specifier, exported unchanged. */
function adminRowSource(specifier: string): string {
  return `'use strict';\nmodule.exports = require(${JSON.stringify(specifier)});\n`;
}

/**
 * The source of a module the register serves, or null for any other id.
 * `senderUrl` is `@pyric/cli`'s Node observed-call sender, by file URL.
 */
export function liveRegisterModuleSource(url: string, senderUrl: string): string | null {
  if (url === REGISTER_OBSERVER_URL) return observerModuleSource(senderUrl, observerImports());
  const adminRow = adminRowOfUrl(url);
  const adminLoad = adminRow === null ? undefined : ADMIN_ROW_LOADS.get(adminRow);
  if (adminLoad !== undefined) return adminRowSource(adminLoad.specifier);
  const specifier = rowOf(url);
  return specifier === undefined ? null : rowModuleSource(specifier, NODE_IMPORTS);
}
