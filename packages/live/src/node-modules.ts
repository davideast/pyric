/**
 * The source of the modules a Node process gets for the four live rows.
 * `@pyric/cli`'s register fixes their ids and loads this file from the
 * `@pyric/live` installed in the project (its `./node-modules` export), so
 * the rows open only where this package is installed. It also exports the
 * refusal those rows give, and the refusal of pyric's own writes the
 * `pyric-live` host gives (`refusal.ts`), and the folder the rows resolve
 * the app's `firebase` from (`start-checks.ts`). The row and observer
 * sources are every plane's (`row-source.ts`); a Node process imports this
 * package's built files and the observer module by file URL.
 *
 * Every live module hands its records to one observer module, which sends
 * them to the Node host on the process's own connection.
 */
import {
  REGISTER_OBSERVER_URL,
  REGISTER_ROW_URLS,
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

/**
 * The source of a module the register serves, or null for any other id.
 * `senderUrl` is `@pyric/cli`'s Node observed-call sender, by file URL.
 */
export function liveRegisterModuleSource(url: string, senderUrl: string): string | null {
  if (url === REGISTER_OBSERVER_URL) return observerModuleSource(senderUrl, NODE_IMPORTS);
  const specifier = rowOf(url);
  return specifier === undefined ? null : rowModuleSource(specifier, NODE_IMPORTS);
}
