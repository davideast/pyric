/**
 * Starts the in-page sandbox backend for Next.js client pages that import
 * only `firebase/auth` (`@pyric/cli/next/internal/auth`, #2046).
 *
 * Next.js renders its own HTML without `serve/entries/page.js`, so on the
 * in-page path (`!useWorker`) this module publishes
 * `globalThis.__PYRIC_PAGE_BACKEND__` before `serve/entries/auth.js` wires
 * session restore and auth-state persistence. Service Workers and Node realms
 * have no `document`, and worker/hosted modes set `useWorker = true`, so none
 * of them loads `runtime.js` or encounters top-level await (#697).
 */
import '../serve/entries/init.js';
import { useWorker } from '../serve/entries/worker-runtime.js';

const isBrowserPage = typeof document !== 'undefined';
if (isBrowserPage && !useWorker) {
  globalThis.__PYRIC_PAGE_BACKEND__ ??= import('../serve/entries/runtime.js');
}
