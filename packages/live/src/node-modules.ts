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
 * class-defining loads, patch its classes with that row's observer (A-4 to
 * A-7 in the #2304 plan, `observeAdminRow`) and export it as it is.
 */
import {
  ADMIN_ROW_LOADS,
  REGISTER_OBSERVER_URL,
  REGISTER_ROW_URLS,
  adminRowOfUrl,
  type AdminRowName,
  type ServedFirebaseSpecifier,
} from '@pyric/cli/register/internal/supplied-rows';
import { fileURLToPath } from 'node:url';
import { LIVE_ROWS } from './rows.js';
import { LIVE_REFUSED } from './refusal.js';
export { liveRefusal, liveWriteRefusal } from './refusal.js';
export { appFirebaseRoot as liveRegisterSdkRoot } from './start-checks.js';
import { observerModuleSource, rowModuleSource, type RowImports } from './row-source.js';
import type { LiveCallRecord, LiveObserver } from './observe.js';
import { adminProjectGate, type AdminProjectGate } from './admin/project-gate.js';
import { observeAdminAuth } from './admin/auth.js';
import { observeAdminDatabase } from './admin/database.js';
import { observeAdminFirestore } from './admin/firestore.js';
import { observeAdminStorage } from './admin/storage.js';

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

/** The project root a child process's first process recorded with no project, once the register says so. */
let rootWithoutProject: string | undefined;

/**
 * Marks this process as one whose recorded project root names no project, as
 * the register finds in such a child process: every Admin row then refuses
 * its firebase-admin load, since no Admin call could be gated.
 */
export function refuseAdminWithoutHostProject(projectRoot: string): void {
  rootWithoutProject = projectRoot;
}

/** The refusal of an Admin row's load in a process with no host project. */
function noHostProjectRefusal(name: AdminRowName, projectRoot: string): Error {
  const message = `@pyric/live: firebase-admin/${name} is refused in live mode, from a Node process: this process has no live project, ` +
    `because ${projectRoot} names no Firebase project, so no Admin call could be checked against one. ` +
    'Set the project in .firebaserc or firebase.json, then start again.';
  return Object.assign(new Error(message), { code: LIVE_REFUSED });
}

/** How the observer module imports, with the host's project once it is known. */
function observerImports(): RowImports {
  if (hostProjectId === undefined) return NODE_IMPORTS;
  return { ...NODE_IMPORTS, hostProjectId };
}

/** The one Admin project gate of this process, for the host's project; its line goes to stderr once. */
let adminGate: AdminProjectGate | undefined;

function adminGateFor(projectId: string): AdminProjectGate {
  adminGate ??= adminProjectGate(projectId, (line) => void process.stderr.write(`${line}\n`));
  return adminGate;
}

/** The rows' observer, carrying the host's project, so a call to another project's instance or bucket is refused. */
function adminObserver(observer: LiveObserver, projectId: string): LiveObserver {
  if (observer.hostProjectId === projectId) return observer;
  const send = (record: LiveCallRecord): unknown => observer(record);
  return Object.assign(send, { journal: observer.journal, measure: observer.measure, client: observer.client, hostProjectId: projectId });
}

/**
 * Patches the real module behind one Admin row, loaded from `entryFile`,
 * with that row's observer (A-4 to A-7 in the #2304 plan). Every row
 * observes for the host's project and passes the process's one project gate.
 * A child process whose recorded project root names no project refuses the
 * load (`refuseAdminWithoutHostProject`). Only `@pyric/cli`'s seam run alone,
 * with no register, leaves the module as it is.
 * The Admin row module calls this; it is not for apps.
 */
export function observeAdminRow(name: AdminRowName, real: unknown, entryFile: string, observer: LiveObserver): void {
  const projectId = hostProjectId;
  if (projectId === undefined && rootWithoutProject !== undefined) throw noHostProjectRefusal(name, rootWithoutProject);
  if (projectId === undefined) return;
  const row = { observer: adminObserver(observer, projectId), gate: adminGateFor(projectId) };
  if (name === 'firestore') observeAdminFirestore(real, entryFile, row);
  if (name === 'storage') observeAdminStorage(real, entryFile, row);
  if (name === 'database') observeAdminDatabase(real, { ...row, hostProjectId: projectId });
  if (name === 'auth') observeAdminAuth(real, { ...row, hostProjectId: projectId });
}

/** This file, which each Admin row module requires for {@link observeAdminRow}: the same module instance the register loaded. */
const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * An Admin row's source: the real module at its load, required by its own
 * specifier, patched by {@link observeAdminRow} with the rows' observer, and
 * exported unchanged. The real file is the one the row's require loaded.
 */
function adminRowSource(name: AdminRowName, specifier: string): string {
  return [
    "'use strict';",
    `const real = require(${JSON.stringify(specifier)});`,
    'const loaded = module.children.find((child) => child.exports === real);',
    `const { observeAdminRow } = require(${JSON.stringify(THIS_FILE)});`,
    `const { observer } = require(${JSON.stringify(REGISTER_OBSERVER_URL)});`,
    `observeAdminRow(${JSON.stringify(name)}, real, loaded === undefined ? __filename : loaded.filename, observer);`,
    'module.exports = real;',
    '',
  ].join('\n');
}

/**
 * The source of a module the register serves, or null for any other id.
 * `senderUrl` is `@pyric/cli`'s Node observed-call sender, by file URL.
 */
export function liveRegisterModuleSource(url: string, senderUrl: string): string | null {
  if (url === REGISTER_OBSERVER_URL) return observerModuleSource(senderUrl, observerImports());
  const adminRow = adminRowOfUrl(url);
  const adminLoad = adminRow === null ? undefined : ADMIN_ROW_LOADS.get(adminRow);
  if (adminRow !== null && adminLoad !== undefined) return adminRowSource(adminRow, adminLoad.specifier);
  const specifier = rowOf(url);
  return specifier === undefined ? null : rowModuleSource(specifier, NODE_IMPORTS);
}
