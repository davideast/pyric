/**
 * Browser client stop module for Next.js (`withPyric`).
 *
 * Evaluates in the browser when a client component imports an unserved
 * `firebase/*` subpath, bare `firebase`, `firebase-admin`, or a direct
 * `@firebase/*` package, stopping before the real Firebase SDK can load or
 * reach production (ADR 0022).
 */
const REAL_SDK_STOPPED_CODE = 'PYRIC_REAL_SDK_STOPPED';
const REPORT_URL = 'https://github.com/davideast/pyric/issues/new';

const message = [
  '@pyric/cli/next: stopped loading an unserved Firebase SDK module in a client bundle',
  'Under withPyric(), served firebase/* subpaths resolve to the local Pyric sandbox, and unserved or direct @firebase/* / firebase-admin imports are stopped so client bundles never reach production Firebase.',
  "Fix: import a served 'firebase/*' subpath (for example 'firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/database', or 'firebase/storage'), or run Next.js without withPyric() to use the real SDK.",
  `If pyric should have routed this import, report it: ${REPORT_URL}`,
  `code: ${REAL_SDK_STOPPED_CODE}`,
].join('\n');

const stopError = Object.assign(new Error(message), { code: REAL_SDK_STOPPED_CODE });
throw stopError;
