/**
 * The source of a live row module and of the observer module the rows
 * share, for every plane. A plane says how its modules name this package's
 * files and the observer module: the page plane by `/@fs` paths and a
 * virtual specifier (`page-modules.ts`), the Node register by file URLs
 * (`node-modules.ts`).
 *
 * A row module imports the app's own installed module for its specifier
 * (each plane sends a row's own import of its specifier to the installed
 * SDK), re-exports every export of it, and replaces the observed and the
 * guarded exports with the ones `liveModuleFor` returns. A named export
 * takes precedence over the same name from `export *`, so the app sees the
 * wrapper; every other export is the SDK's own binding. The row names its
 * client, so a refusal says where the call was made.
 */
import type { ServedFirebaseSpecifier } from '@pyric/cli/vite/internal/supplied-rows';
import { replacedExports } from './modules.js';
import type { LiveClient } from './refusal.js';
import { LIVE_ROWS } from './rows.js';

/** How a plane's modules import this package's files and the observer module. */
export interface RowImports {
  /** The import specifier of one of this package's modules, by its name without an extension (`rows`). */
  file(name: string): string;
  /** The specifier the row modules import the observer module by. */
  readonly observer: string;
  /** The client the rows run in, which a refusal names. */
  readonly client: LiveClient;
}

/** Where a live module reads the installed SDK's version: `firebase/app` itself, or the live app row. */
function sdkVersionImport(specifier: ServedFirebaseSpecifier): string {
  const isApp = specifier === 'firebase/app';
  if (isApp) return 'const SDK_VERSION = __pyricReal.SDK_VERSION;';
  return "import { SDK_VERSION } from 'firebase/app';";
}

/** The source of the live row module for `specifier`. Throws for a specifier with no live row. */
export function rowModuleSource(specifier: ServedFirebaseSpecifier, imports: RowImports): string {
  const key = LIVE_ROWS.get(specifier);
  if (key === undefined) throw new Error(`@pyric/live has no live row for ${specifier}.`);
  const names = replacedExports(key);
  const site = `{ observer, sdkVersion: SDK_VERSION, client: ${JSON.stringify(imports.client)} }`;
  const quoted = JSON.stringify(specifier);
  return [
    `import * as __pyricReal from ${quoted};`,
    sdkVersionImport(specifier),
    `import { liveModuleFor } from ${JSON.stringify(imports.file('rows'))};`,
    `import { observer } from ${JSON.stringify(imports.observer)};`,
    `export * from ${quoted};`,
    `const __pyricLive = liveModuleFor(${quoted}, __pyricReal, ${site});`,
    ...names.map((name) => `export const ${name} = __pyricLive.${name};`),
    '',
  ].join('\n');
}

/** The observer module's lines on a page, whose observer also journals each Firestore listener. */
function pageObserverLines(sender: string, observer: string): string[] {
  return [
    `import { sendObservedCall } from ${JSON.stringify(sender)};`,
    `import { journalLiveListener } from ${JSON.stringify(sender)};`,
    `import { pageObserver } from ${observer};`,
    'export const observer = Object.assign(pageObserver(sendObservedCall), { journal: journalLiveListener });',
  ];
}

/**
 * The source of the observer module: each record that has a row goes to the
 * host through `sender`. On a page, the observer also journals each Firestore
 * listener through the page sender's `journalLiveListener`, in the SDK
 * activity the runtime chip's Listeners view and Flow read. A Node process
 * has no chip.
 */
export function observerModuleSource(sender: string, imports: RowImports): string {
  const observer = JSON.stringify(imports.file('page-observer'));
  const isPage = imports.client === 'page';
  const lines = isPage ? pageObserverLines(sender, observer) : [
    `import { sendObservedCall } from ${JSON.stringify(sender)};`,
    `import { pageObserver } from ${observer};`,
    'export const observer = pageObserver(sendObservedCall);',
  ];
  return [...lines, ''].join('\n');
}
