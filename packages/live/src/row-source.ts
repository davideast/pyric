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
  /**
   * The project the plane's host serves, once the plane has resolved it.
   * Every row then refuses a call whose app names another project
   * (`refusedProject` in `observe.ts`); without it no call is refused by project.
   */
  readonly hostProjectId?: string;
}

/**
 * Where a live module reads the installed SDK's version and its initialized
 * apps (`getApps`, which no row observes): `firebase/app` itself, or the
 * live app row.
 */
function sdkVersionImport(specifier: ServedFirebaseSpecifier): string {
  const isApp = specifier === 'firebase/app';
  if (isApp) return 'const SDK_VERSION = __pyricReal.SDK_VERSION; const __pyricGetApps = __pyricReal.getApps;';
  return "import { SDK_VERSION, getApps as __pyricGetApps } from 'firebase/app';";
}

/** The source of the live row module for `specifier`. Throws for a specifier with no live row. */
export function rowModuleSource(specifier: ServedFirebaseSpecifier, imports: RowImports): string {
  const key = LIVE_ROWS.get(specifier);
  if (key === undefined) throw new Error(`@pyric/live has no live row for ${specifier}.`);
  const names = replacedExports(key);
  const site = `{ observer, sdkVersion: SDK_VERSION, client: ${JSON.stringify(imports.client)}, apps: __pyricGetApps }`;
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

/** The observer's own fields, as source: the host's project when the plane has it, and the client. */
function observerFields(imports: RowImports): string[] {
  const client = `client: ${JSON.stringify(imports.client)}`;
  if (imports.hostProjectId === undefined) return [client];
  return [`hostProjectId: ${JSON.stringify(imports.hostProjectId)}`, client];
}

/** The observer module's lines on a page, whose observer also journals each Firestore listener. */
function pageObserverLines(sender: string, observer: string, imports: RowImports): string[] {
  const fields = ['journal: journalLiveListener', ...observerFields(imports)].join(', ');
  return [
    `import { sendObservedCall } from ${JSON.stringify(sender)};`,
    `import { journalLiveListener } from ${JSON.stringify(sender)};`,
    `import { pageObserver } from ${observer};`,
    `export const observer = Object.assign(pageObserver(sendObservedCall), { ${fields} });`,
  ];
}

/** The observer module's lines in a Node process, which has no chip and so journals nothing. */
function nodeObserverLines(sender: string, observer: string, imports: RowImports): string[] {
  const fields = observerFields(imports).join(', ');
  return [
    `import { sendObservedCall } from ${JSON.stringify(sender)};`,
    `import { pageObserver } from ${observer};`,
    `export const observer = Object.assign(pageObserver(sendObservedCall), { ${fields} });`,
  ];
}

/**
 * The source of the observer module: each record that has a row goes to the
 * host through `sender`. On a page, the observer also journals each Firestore
 * listener through the page sender's `journalLiveListener`, in the SDK
 * activity the runtime chip's Listeners view and Flow read. The observer
 * names the client and, once the plane has resolved it, the host's project,
 * so every row it serves refuses a call to another project.
 */
export function observerModuleSource(sender: string, imports: RowImports): string {
  const observer = JSON.stringify(imports.file('page-observer'));
  const isPage = imports.client === 'page';
  if (isPage) return [...pageObserverLines(sender, observer, imports), ''].join('\n');
  return [...nodeObserverLines(sender, observer, imports), ''].join('\n');
}
