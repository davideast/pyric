/**
 * Live mode's refusal of a Firebase import it has no live row for. The app
 * gets this error instead of the sandbox's module, so one app object never
 * mixes production Firestore and Auth with a sandbox service.
 */
import type { SuppliedRowsPlane } from '@pyric/cli/vite/internal/supplied-rows';

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

function serviceOf(specifier: string): string {
  const isAdmin = specifier === 'firebase-admin' || specifier.startsWith('firebase-admin/');
  if (isAdmin) return 'the Admin SDK';
  return SERVICE_NAMES[specifier] ?? specifier;
}

const SERVED = 'firebase/app, firebase/auth, firebase/firestore and firebase/app-check';

/** The error for `specifier`, imported from page code or from server code the dev server runs. */
export function liveRefusal(specifier: string, plane: SuppliedRowsPlane): Error {
  const service = serviceOf(specifier);
  const where = plane === 'page'
    ? `Live mode serves only ${SERVED} to pages, from your installed Firebase SDK.`
    : 'Live mode serves Firebase to pages only; server code the dev server runs gets no Firebase module yet.';
  const message = `@pyric/live: ${specifier} (${service}) is refused in live mode. ${where} ` +
    `It is not served from the Pyric sandbox either, so production and sandbox services never share one app. ` +
    'Remove the import, or run the app without @pyric/live to use the sandbox.';
  return Object.assign(new Error(message), { code: LIVE_REFUSED });
}
