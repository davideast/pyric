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

/** The `code` of every live mode refusal. */
export const LIVE_REFUSED = 'PYRIC_LIVE_REFUSED';

/** The service each refused specifier names, for the message. */
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

const SERVED = 'firebase/app, firebase/auth, firebase/firestore and firebase/app-check';

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
