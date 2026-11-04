/**
 * The source of the modules a page gets for the four live rows. `@pyric/cli`
 * fixes their ids and loads this file from the `@pyric/live` installed in
 * the project (its `./page-modules` export), so the rows open only where
 * this package is installed. Each
 * one imports the app's own installed module for its specifier (the swap
 * sends a row's own import of its specifier to the installed SDK), re-exports
 * every export of it, and replaces the observed exports with the wrapped
 * ones `liveModuleFor` returns. A named export takes precedence over the
 * same name from `export *`, so the page sees the wrapper; every other export
 * is the SDK's own binding.
 *
 * Every live module hands its records to one observer module, which sends
 * them to the Node host on the page's own connection.
 */
import { fileURLToPath } from 'node:url';
import {
  OBSERVER_MODULE_ID,
  OBSERVER_SPECIFIER,
  ROW_MODULE_IDS,
  type ServedFirebaseSpecifier,
} from '@pyric/cli/vite/internal/supplied-rows';
import { LIVE_MODULES } from './modules.js';
import { LIVE_ROWS } from './rows.js';

/** The live row a module id serves, or undefined for any other id. */
function rowOf(id: string): ServedFirebaseSpecifier | undefined {
  for (const [specifier, rowId] of ROW_MODULE_IDS) {
    const isRow = rowId === id && LIVE_ROWS.has(specifier);
    if (isRow) return specifier;
  }
  return undefined;
}

/** A file of this package, as the URL a page module imports it by. */
function servedFile(name: string): string {
  return `/@fs${fileURLToPath(new URL(`./${name}`, import.meta.url))}`;
}

/** Where a live module reads the installed SDK's version: `firebase/app` itself, or the live app row. */
function sdkVersionImport(specifier: ServedFirebaseSpecifier): string {
  const isApp = specifier === 'firebase/app';
  if (isApp) return 'const SDK_VERSION = __pyricReal.SDK_VERSION;';
  return "import { SDK_VERSION } from 'firebase/app';";
}

function rowModule(specifier: ServedFirebaseSpecifier): string {
  const key = LIVE_ROWS.get(specifier);
  if (key === undefined) throw new Error(`@pyric/live has no live row for ${specifier}.`);
  const spec = LIVE_MODULES[key];
  const names = [...spec.calls, ...spec.listeners];
  const quoted = JSON.stringify(specifier);
  return [
    `import * as __pyricReal from ${quoted};`,
    sdkVersionImport(specifier),
    `import { liveModuleFor } from ${JSON.stringify(servedFile('rows.ts'))};`,
    `import { observer } from ${JSON.stringify(OBSERVER_SPECIFIER)};`,
    `export * from ${quoted};`,
    `const __pyricLive = liveModuleFor(${quoted}, __pyricReal, observer, SDK_VERSION);`,
    ...names.map((name) => `export const ${name} = __pyricLive.${name};`),
    '',
  ].join('\n');
}

function observerModule(senderFile: string): string {
  return [
    `import { sendObservedCall } from ${JSON.stringify(`/@fs${senderFile}`)};`,
    `import { pageObserver } from ${JSON.stringify(servedFile('page-observer.ts'))};`,
    'export const observer = pageObserver(sendObservedCall);',
    '',
  ].join('\n');
}

/**
 * The source of a module this plugin serves, or null for any other id.
 * `senderFile` is `@pyric/cli`'s observed-call sender, on disk.
 */
export function liveModuleSource(id: string, senderFile: string): string | null {
  if (id === OBSERVER_MODULE_ID) return observerModule(senderFile);
  const specifier = rowOf(id);
  return specifier === undefined ? null : rowModule(specifier);
}
