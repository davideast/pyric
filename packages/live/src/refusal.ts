/**
 * Live mode's refusals. Each one throws before any request leaves, with the
 * code `PYRIC_LIVE_REFUSED`, and names live mode, what was refused and the
 * client that asked:
 *
 * - a Firebase import live mode has no row for (`liveRefusal`), so one app
 *   object never mixes production Firestore and Auth with a sandbox service;
 * - a call through a live row that would reach what the first slice does not
 *   serve, such as a named Firestore database (`liveCallRefusal`);
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

/** `firebase/app, firebase/auth, firebase/firestore, firebase/app-check and firebase/database`. */
const SERVED = joinedList([...SERVED_IMPORTS]);

/** What live mode serves where the import was made. */
const SERVED_ON: Readonly<Record<SuppliedRowsPlane, string>> = {
  page: `Live mode serves only ${SERVED} to pages, from your installed Firebase SDK.`,
  server: 'Live mode serves Firebase to pages only; server code the dev server runs gets no Firebase module yet.',
  node: `Live mode serves only ${SERVED} to a Node process, from your installed Firebase SDK.`,
};

function refused(message: string): Error {
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

/** Whether `pyricLive({ passThrough })` can list `specifier`. */
export function canPassThrough(specifier: string): boolean {
  return PASS_THROUGH_CANDIDATES.includes(specifier);
}

/** What is wrong with one `passThrough` entry, or null when it can pass through. */
function passThroughProblem(entry: unknown): string | null {
  if (typeof entry !== 'string') return `passThrough lists ${JSON.stringify(entry)}, which is not an import name.`;
  if (canPassThrough(entry)) return null;
  if (SERVED_IMPORTS.has(entry)) return `passThrough lists ${entry}, which live mode already serves and observes; remove it.`;
  const servedAs = SERVED_SERVICE_IMPORTS[entry];
  if (servedAs !== undefined) {
    return `passThrough lists ${entry}, which cannot pass through: live mode serves this service as ${servedAs}, ` +
      `and its calls would reach it unobserved and uncounted. Import ${servedAs} instead.`;
  }
  if (serviceOf(entry) === 'the Admin SDK') {
    return `passThrough lists ${entry}, which never passes through: live mode refuses the Admin SDK in every process.`;
  }
  const packageImport = packageImportOf(entry);
  if (packageImport !== null) return `passThrough lists ${entry}, an SDK package name; list ${packageImport}, the import apps write.`;
  return `passThrough lists ${entry}, which is not a Firebase import live mode can pass through. It takes ${PASS_THROUGH_CANDIDATES.join(', ')}.`;
}

/**
 * The `passThrough` option as a list, each import once. Throws a start-time
 * configuration error naming every entry that cannot pass through: one live
 * mode serves, `firebase-admin`, an `@firebase/*` package name, or anything
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

/** `firebase/ai (Firebase AI Logic) and firebase/functions (Cloud Functions)`. */
function namedList(specifiers: readonly string[]): string {
  return joinedList(specifiers.map((specifier) => `${specifier} (${serviceOf(specifier)})`));
}

/** The option that would let each of `specifiers` load: `pyricLive({ passThrough: ['firebase/ai'] })`. */
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
  const where = SERVED_ON[plane];
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

const WRITER_NAMES: Readonly<Record<PyricWriter, string>> = {
  studio: 'Studio',
  mcp: 'an MCP tool',
  command: 'a pyric command',
  seed: 'the seed file',
  page: "a page's pyric runtime",
  node: "a Node process's pyric runtime",
  admin: 'server admin code',
};

/** The error for a write pyric itself would make under live mode. */
export function liveWriteRefusal(write: PyricWrite): Error {
  return refused(`@pyric/live: ${write.action} from ${WRITER_NAMES[write.writer]} is refused in live mode. ` +
    "The app's own Firestore and Auth calls go to your Firebase project, and pyric holds no production " +
    'credential, so it never writes on its own: not from Studio, an MCP tool, a pyric command or a seed file. ' +
    'Make the change from the app, or run without @pyric/live to edit the sandbox.');
}
