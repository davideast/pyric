/**
 * Live mode's refusals. Each one throws before any request leaves, with the
 * code `PYRIC_LIVE_REFUSED`, and names live mode, what was refused and the
 * client that asked:
 *
 * - a Firebase import live mode has no row for (`liveRefusal`), so one app
 *   object never mixes the production services it serves with a sandbox
 *   service;
 * - a call through a live row that would reach what live mode does not
 *   serve, such as a named Firestore database or the AI Live API
 *   (`liveCallRefusal`);
 * - a call through a live row whose app names another project than the
 *   host's (`liveProjectRefusal`), so a live host never sends one project's
 *   calls to another;
 * - a write pyric itself would make, from Studio, an MCP tool, a pyric
 *   command or a seed file (`liveWriteRefusal`). Pyric holds no production
 *   credential and never writes on its own; the app's own writes go to
 *   production through the live rows.
 *
 * Loaded in the page too, so it imports only types from `@pyric/cli`.
 */
import type { PyricWrite, PyricWriter, SuppliedRowsPlane } from '@pyric/cli/vite/internal/supplied-rows';
import { LIVE_ROW_SPECIFIERS } from './row-specifiers.js';

/** The `code` of every live mode refusal. */
export const LIVE_REFUSED = 'PYRIC_LIVE_REFUSED';

/**
 * The service each specifier without a live row names, for the message. A
 * specifier that gains a row stays here, so its name is ready for messages,
 * and leaves the pass-through candidates.
 */
const SERVICE_NAMES: Readonly<Record<string, string>> = {
  'firebase/ai': 'Firebase AI Logic',
  'firebase/analytics': 'Analytics',
  'firebase/database': 'Realtime Database',
  'firebase/firestore/lite': 'Firestore Lite',
  'firebase/functions': 'Cloud Functions',
  'firebase/messaging': 'Cloud Messaging',
  'firebase/messaging/sw': 'Cloud Messaging',
  'firebase/performance': 'Performance Monitoring',
  'firebase/remote-config': 'Remote Config',
  'firebase/storage': 'Cloud Storage',
};

const SDK_PACKAGE_PREFIX = '@firebase/';

/** `@firebase/firestore` → `firebase/firestore`, the import an app writes for that package. */
function packageImportOf(specifier: string): string | null {
  if (!specifier.startsWith(SDK_PACKAGE_PREFIX)) return null;
  const packageName = specifier.slice(SDK_PACKAGE_PREFIX.length).split('/')[0];
  return `firebase/${packageName}`;
}

function serviceOf(specifier: string): string {
  const isAdmin = specifier === 'firebase-admin' || specifier.startsWith('firebase-admin/');
  if (isAdmin) return 'the Admin SDK';
  const packageImport = packageImportOf(specifier);
  if (packageImport !== null) return `a Firebase SDK package; apps import ${packageImport}`;
  return SERVICE_NAMES[specifier] ?? specifier;
}

/**
 * The imports live mode serves and observes, one per live row. Each is
 * refused as a `passThrough` entry, since it is already served.
 */
const SERVED_IMPORTS: ReadonlySet<string> = new Set(LIVE_ROW_SPECIFIERS.map(([specifier]) => specifier));

/** `a, b and c`. */
function joinedList(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** `firebase/app, firebase/auth, firebase/firestore, firebase/app-check, firebase/database, firebase/ai and firebase/storage`. */
const SERVED = joinedList([...SERVED_IMPORTS]);

/** What live mode serves where the import was made. */
const SERVED_ON: Readonly<Record<SuppliedRowsPlane, string>> = {
  page: `Live mode serves only ${SERVED} to pages, from your installed Firebase SDK.`,
  server: 'Live mode serves Firebase to pages only; server code the dev server runs gets no Firebase module yet.',
  node: `Live mode serves only ${SERVED} to a Node process, from your installed Firebase SDK.`,
};

/** The lowest Node major whose CommonJS `require()` reaches `module.registerHooks`; Node 22's never does. */
export const ADMIN_ROWS_NODE_MAJOR = 23;

/** The Node version this process runs, or undefined on a page. */
function nodeVersionHere(): string | undefined {
  const versions: unknown = Reflect.get(globalThis, 'process')?.versions;
  const node: unknown = typeof versions === 'object' && versions !== null ? Reflect.get(versions, 'node') : undefined;
  return typeof node === 'string' ? node : undefined;
}

/**
 * Why the Admin rows cannot run on `nodeVersion`, or null from
 * {@link ADMIN_ROWS_NODE_MAJOR} on. On Node 22 the register keeps them shut
 * and refuses every `firebase-admin` import with this reason, so a process
 * that never imports the Admin SDK still starts.
 */
export function adminRowsNodeProblem(nodeVersion: string | undefined = nodeVersionHere()): string | null {
  const isSupportedNode = nodeVersion === undefined || Number(nodeVersion.split('.')[0]) >= ADMIN_ROWS_NODE_MAJOR;
  if (isSupportedNode) return null;
  return `@pyric/live observes firebase-admin on Node ${ADMIN_ROWS_NODE_MAJOR} or later, where its require() calls reach the live register, ` +
    `and this process runs Node ${nodeVersion}. Start it with Node ${ADMIN_ROWS_NODE_MAJOR} or later.`;
}

/** What live mode serves of the Admin SDK in a Node process: the services its Admin rows observe. */
const ADMIN_SERVED = `Live mode serves only firebase-admin's app, Firestore, Auth, Realtime Database and Storage to a Node process, and observes their calls.`;

function refused(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: LIVE_REFUSED });
}

/**
 * Imports of a service live mode serves, under another entry: they stay
 * refused, since their calls would reach the served service unobserved and
 * "Billed calls" would never count them.
 */
const SERVED_SERVICE_IMPORTS: Readonly<Record<string, string>> = {
  'firebase/firestore/lite': 'firebase/firestore',
};

/** Whether `specifier` is another entry to a service live mode serves, such as Firestore Lite. */
function isServedServiceImport(specifier: string): boolean {
  return Object.hasOwn(SERVED_SERVICE_IMPORTS, specifier);
}

/**
 * The imports `pyricLive({ passThrough })` can list: every served Firebase
 * import live mode has no row for. Each loads the app's installed SDK
 * unwrapped and unobserved.
 */
export const PASS_THROUGH_CANDIDATES: readonly string[] = Object.keys(SERVICE_NAMES)
  .filter((specifier) => !SERVED_IMPORTS.has(specifier) && !isServedServiceImport(specifier));

/** Whether `specifier` is a page import `pyricLive({ passThrough })` can list. */
export function canPassThrough(specifier: string): boolean {
  return PASS_THROUGH_CANDIDATES.includes(specifier);
}

/**
 * The Admin SDK. Live mode serves and observes it in a Node process under
 * `@pyric/live/register` through the Admin rows, so a `passThrough` entry
 * naming it stops the start, as one naming a served page import does. Pages
 * and server code the dev server runs still refuse it.
 */
export const ADMIN_PASS_THROUGH = 'firebase-admin';

/** What is wrong with one `passThrough` entry, or null when it can pass through. */
function passThroughProblem(entry: unknown): string | null {
  if (typeof entry !== 'string') return `passThrough lists ${JSON.stringify(entry)}, which is not an import name.`;
  if (canPassThrough(entry)) return null;
  const isServed = SERVED_IMPORTS.has(entry) || entry === ADMIN_PASS_THROUGH;
  if (isServed) return `passThrough lists ${entry}, which live mode already serves and observes; remove it.`;
  const servedAs = SERVED_SERVICE_IMPORTS[entry];
  if (servedAs !== undefined) {
    return `passThrough lists ${entry}, which cannot pass through: live mode serves this service as ${servedAs}, ` +
      `and its calls would reach it unobserved and uncounted. Import ${servedAs} instead.`;
  }
  if (serviceOf(entry) === 'the Admin SDK') {
    return `passThrough lists ${entry}, an Admin SDK subpath; live mode already serves and observes ${ADMIN_PASS_THROUGH} in a Node process under @pyric/live/register; remove it.`;
  }
  const packageImport = packageImportOf(entry);
  if (packageImport !== null) return `passThrough lists ${entry}, an SDK package name; list ${packageImport}, the import apps write.`;
  return `passThrough lists ${entry}, which is not a Firebase import live mode can pass through. It takes ${PASS_THROUGH_CANDIDATES.join(', ')}.`;
}

/**
 * The `passThrough` option as a list, each import once. Throws a start-time
 * configuration error naming every entry that cannot pass through: one live
 * mode serves, `firebase-admin` ({@link ADMIN_PASS_THROUGH}) or a
 * `firebase-admin/*` subpath, an `@firebase/*` package name, or anything
 * else that is not a Firebase import live mode has no row for.
 */
export function passThroughOption(entry: string, value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${entry}: passThrough takes a list of Firebase imports, such as ['firebase/functions'].`);
  }
  const problems = value.map(passThroughProblem).filter((problem): problem is string => problem !== null);
  if (problems.length > 0) throw new Error(`${entry}: ${[...new Set(problems)].join(' ')}`);
  return [...new Set(value as string[])];
}

/** `firebase/functions (Cloud Functions) and firebase/remote-config (Remote Config)`. */
function namedList(specifiers: readonly string[]): string {
  return joinedList(specifiers.map((specifier) => `${specifier} (${serviceOf(specifier)})`));
}

/** The option that would let each of `specifiers` load: `pyricLive({ passThrough: ['firebase/functions'] })`. */
export function passThroughOptionFor(specifiers: readonly string[]): string {
  return `pyricLive({ passThrough: [${specifiers.map((specifier) => `'${specifier}'`).join(', ')}] })`;
}

/**
 * The dev server's line for the unserved imports pages asked for so far,
 * sorted: what was refused, and the option that would let each load.
 */
export function refusedImportsLine(entry: string, specifiers: readonly string[]): string {
  const sorted = [...specifiers].sort();
  const isOne = sorted.length === 1;
  return `${entry}: a page imports ${namedList(sorted)}, which live mode does not serve, so ${isOne ? 'that import is' : 'those imports are'} refused. ` +
    `To load ${isOne ? 'it' : 'them'} from your installed Firebase SDK without observing ${isOne ? 'it' : 'them'}, start with ${passThroughOptionFor(sorted)}. ` +
    `${isOne ? 'Its' : 'Their'} calls then go to production unobserved and still bill.`;
}

/** A page refusal of a passable import, with the option that would let it load. */
export function withPassThroughHint(error: Error, specifier: string): Error {
  const hint = ` To load it from your installed Firebase SDK without observing it, list it in ${passThroughOptionFor([specifier])}; ` +
    'its calls then go to production unobserved and still bill.';
  return Object.assign(new Error(`${error.message}${hint}`), { code: LIVE_REFUSED });
}

/**
 * The error for `specifier`, imported from page code, from server code the
 * dev server runs, or from a Node process under `@pyric/live/register`.
 */
export function liveRefusal(specifier: string, plane: SuppliedRowsPlane): Error {
  const service = serviceOf(specifier);
  const isNodeAdmin = plane === 'node' && service === 'the Admin SDK';
  const where = isNodeAdmin ? (adminRowsNodeProblem() ?? ADMIN_SERVED) : SERVED_ON[plane];
  return refused(`@pyric/live: ${specifier} (${service}) is refused in live mode. ${where} ` +
    `It is not served from the Pyric sandbox either, so production and sandbox services never share one app. ` +
    'Remove the import, or run the app without @pyric/live to use the sandbox.');
}

/** A client a live row runs in: a page, or a Node process under `@pyric/live/register`. */
export type LiveClient = Exclude<SuppliedRowsPlane, 'server'>;

const CLIENT_NAMES: Readonly<Record<LiveClient, string>> = {
  page: 'a page',
  node: 'a Node process',
};

/** A call a live row refuses: what it names, and what the app can do instead. */
export interface RefusedCall {
  /** The call as the app wrote it, such as `getFirestore(app, 'reports')`. */
  readonly call: string;
  /** What the call would reach, such as `the Firestore database 'reports'`. */
  readonly reaches: string;
  /** What live mode serves instead, such as `only the (default) database`. */
  readonly serves: string;
}

/** The error for a call through a live row that reaches what live mode does not serve. */
export function liveCallRefusal(refusedCall: RefusedCall, client: LiveClient): Error {
  return refused(`@pyric/live: ${refusedCall.call} is refused in live mode, from ${CLIENT_NAMES[client]}: ` +
    `it would reach ${refusedCall.reaches}, and live mode serves ${refusedCall.serves}. ` +
    'The call threw before any request left. Run the app without @pyric/live to use the sandbox.');
}

/** What a call reaches beside its app's config: the RTDB instance or the Cloud Storage bucket. */
export type CallTargetField = 'instance' | 'bucket';

export const CALL_TARGET_FIELDS: readonly CallTargetField[] = ['instance', 'bucket'];

/**
 * The fields the project check judges: the project id, the config fields
 * whose default forms encode one, and the instance or bucket the call
 * reaches, whose default forms do too.
 */
export type ProjectField = 'projectId' | 'databaseURL' | 'storageBucket' | 'authDomain' | CallTargetField;

const TARGET_NAMES: Readonly<Record<CallTargetField, string>> = {
  instance: 'the database instance it reaches',
  bucket: 'the bucket it reaches',
};

/** Where the refused project was named: a field of the app's config, or the instance or bucket the call reaches. */
function namedBy(field: ProjectField): string {
  if (isCallTarget(field)) return TARGET_NAMES[field];
  return `its app's ${field}`;
}

function isCallTarget(field: ProjectField): field is CallTargetField {
  return field === 'instance' || field === 'bucket';
}

/** The two projects a refused call names: the one its app's config or its target names, in `field`, and the host's. */
export interface ProjectMismatch {
  readonly field: ProjectField;
  readonly appProjectId: string;
  readonly hostProjectId: string;
}

/** A project refusal's data: the code, the field judged and both projects, for a caller that reads it without the message. */
export type LiveProjectRefusal = Error & ProjectMismatch & { readonly code: string };

/**
 * The error for a call through a live row whose app names another project
 * than the host's. `client` is absent when the observer does not name it.
 */
export function liveProjectRefusal(call: string, projects: ProjectMismatch, client?: LiveClient): LiveProjectRefusal {
  const from = client === undefined ? 'a client' : CLIENT_NAMES[client];
  const error = refused(`@pyric/live: ${call} is refused in live mode, from ${from}: ` +
    `${namedBy(projects.field)} names the project '${projects.appProjectId}', and this live host serves '${projects.hostProjectId}'. ` +
    `The call threw before any request left. Point the app's config at '${projects.hostProjectId}', ` +
    `or start live mode for '${projects.appProjectId}'.`);
  const { field, appProjectId, hostProjectId } = projects;
  return Object.assign(error, { field, appProjectId, hostProjectId });
}

/**
 * Where an Admin project was named: a project environment variable
 * firebase-admin reads, or what an Admin app itself resolves (its
 * `options.projectId`, or its credential's project).
 */
export type AdminProjectSource =
  | 'GOOGLE_CLOUD_PROJECT'
  | 'GCLOUD_PROJECT'
  | 'FIREBASE_CONFIG'
  | 'options.projectId'
  | 'credential';

/** The projects an Admin refusal names: the one `source` names, and the host's. */
export interface AdminProjectMismatch {
  readonly source: AdminProjectSource;
  readonly appProjectId: string;
  readonly hostProjectId: string;
}

/** An Admin project refusal's data, for a caller that reads it without the message. */
export type LiveAdminProjectRefusal = Error & AdminProjectMismatch & { readonly code: string };

const ADMIN_SOURCE_NAMES: Readonly<Record<AdminProjectSource, string>> = {
  GOOGLE_CLOUD_PROJECT: 'the environment variable GOOGLE_CLOUD_PROJECT',
  GCLOUD_PROJECT: 'the environment variable GCLOUD_PROJECT',
  FIREBASE_CONFIG: 'the projectId in the environment variable FIREBASE_CONFIG',
  'options.projectId': "the Admin app's options.projectId",
  credential: "the Admin app's credential",
};

/**
 * The error for an Admin SDK process or app that names another project than
 * the live host's: thrown at register start for an environment variable, and
 * by every call from an Admin app whose own project differs.
 */
export function liveAdminProjectRefusal(projects: AdminProjectMismatch): LiveAdminProjectRefusal {
  const error = refused(`@pyric/live: firebase-admin is refused in live mode, from a Node process: ` +
    `${ADMIN_SOURCE_NAMES[projects.source]} names the project '${projects.appProjectId}', and this live host serves '${projects.hostProjectId}'. ` +
    `No Admin request left. Point the Admin SDK at '${projects.hostProjectId}', or start live mode for '${projects.appProjectId}'.`);
  const { source, appProjectId, hostProjectId } = projects;
  return Object.assign(error, { source, appProjectId, hostProjectId });
}

/** The instance an Admin app's Realtime Database names, and the live host's project it is checked against. */
export interface AdminInstanceMismatch {
  readonly instance: string;
  readonly hostProjectId: string;
}

/**
 * The refusal of an Admin Realtime Database call to an instance live mode
 * can't tell is the live host's project's: not `<project>-default-rtdb`, not
 * `<project>`, and not one firebase.json names.
 */
export function liveAdminInstanceRefusal(mismatch: AdminInstanceMismatch): Error & AdminInstanceMismatch {
  const error = refused(`@pyric/live: firebase-admin is refused in live mode, from a Node process: ` +
    `the app's databaseURL names the Realtime Database instance '${mismatch.instance}', and live mode can't tell it belongs to '${mismatch.hostProjectId}', the project this live host serves. ` +
    `No Admin request left. If it is an instance of '${mismatch.hostProjectId}', name it in firebase.json's database list ` +
    `({ "instance": "${mismatch.instance}", "rules": "..." }) and start again; otherwise start live mode for the project it belongs to.`);
  return Object.assign(error, mismatch);
}

/** The live host's project, and the firebase-admin version whose Realtime Database instance live mode can't read. */
export interface AdminInstanceUnread {
  readonly hostProjectId: string;
  readonly adminVersion: string | undefined;
}

/**
 * The refusal of an Admin Realtime Database call whose instance live mode
 * can't read, as after a firebase-admin upgrade that moves where the SDK
 * keeps it. Live mode can't tell the instance is the live project's, so it
 * refuses rather than let the call through unchecked.
 */
export function liveAdminInstanceUnreadable(unread: AdminInstanceUnread): Error & AdminInstanceUnread {
  const version = unread.adminVersion === undefined ? 'this firebase-admin version' : `firebase-admin ${unread.adminVersion}`;
  const error = refused(`@pyric/live: firebase-admin is refused in live mode, from a Node process: ` +
    `live mode can't read which Realtime Database instance the app's databaseURL names in ${version}, so it can't tell the instance belongs to '${unread.hostProjectId}', the project this live host serves. ` +
    `No Admin request left. Use a firebase-admin version this @pyric/live supports, or report ${version} to pyric.`);
  return Object.assign(error, unread);
}

/** pyric's own code for an ID token from the other mode, beside firebase-admin's `auth/argument-error`. */
export const MODE_MISMATCH = 'PYRIC_MODE_MISMATCH' as const;

/** The mode-mismatch error, shaped as firebase-admin's own Auth errors: a `code`, and an `errorInfo` holding it. */
export type LiveModeMismatch = Error & { readonly code: string; readonly pyricCode: typeof MODE_MISMATCH; readonly errorInfo: { code: string; message: string } };

/**
 * The error a live backend's `verifyIdToken` or `verifySessionCookie` rejects
 * with for a token a pyric sandbox issued (G-3 in the #2304 plan). It keeps
 * firebase-admin's code for a token it can't verify, so an app's error
 * handling behaves as it would, and adds `pyricCode`.
 */
export function liveModeMismatch(hostProjectId: string): LiveModeMismatch {
  const message = `This backend runs in live mode for ${hostProjectId}, and the request carries an ID token a pyric sandbox issued. ` +
    'Start this backend under pyric run --sandbox, or sign in on the live page.';
  const code = 'auth/argument-error';
  return Object.assign(new Error(message), { code, pyricCode: MODE_MISMATCH, errorInfo: { code, message } });
}

const WRITER_NAMES: Readonly<Record<PyricWriter, string>> = {
  studio: 'Studio',
  mcp: 'an MCP tool',
  command: 'a pyric command',
  seed: 'the seed file',
  page: "a page's pyric runtime",
  node: "a Node process's pyric runtime",
  admin: 'server admin code',
  'service-worker': "a service worker's pyric runtime",
};

/** The error for a write pyric itself would make under live mode. */
export function liveWriteRefusal(write: PyricWrite): Error {
  return refused(`@pyric/live: ${write.action} from ${WRITER_NAMES[write.writer]} is refused in live mode. ` +
    "The app's own Firestore and Auth calls go to your Firebase project, and pyric holds no production " +
    'credential, so it never writes on its own: not from Studio, an MCP tool, a pyric command or a seed file. ' +
    'Make the change from the app, or run without @pyric/live to edit the sandbox.');
}
