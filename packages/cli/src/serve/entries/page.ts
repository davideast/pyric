/**
 * The module script the sandbox injects ahead of a served page's own scripts
 * (`/__pyric/sdk/page.js` under `pyric dev`, the page entry under the Vite
 * plugin). It mounts the page UI (`./init.js`) and, on the in-page path,
 * starts the in-page backend (`./runtime.js`: rules, seed, saved state) for
 * every page, whichever `firebase/*` entries the app imports (#2039).
 *
 * The Firestore, Storage and Database entries import the runtime statically
 * and wait on its top-level await. `firebase/auth` cannot: Service Workers
 * evaluate it and reject top-level await (#697), and a bundler that inlines
 * dynamic imports would pull the runtime back into its graph. This script is
 * never part of a Service Worker's graph, so it loads the runtime here and
 * publishes the load as `globalThis.__PYRIC_PAGE_BACKEND__` before any app
 * module runs; the auth entry waits on it. The runtime is one module per page,
 * so a page that also imports Firestore runs it once.
 */
import './init.js';
import { useWorker } from './worker-runtime.js';

// The worker path owns rules, seed and saved state in the worker, and loads
// the runtime only from the entries that import it, as before.
if (!useWorker) {
  globalThis.__PYRIC_PAGE_BACKEND__ = import('./runtime.js');
}

export {};
