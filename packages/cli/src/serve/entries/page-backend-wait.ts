/**
 * How the in-page auth entries wait for the in-page backend the page script
 * (`./page.ts`) started, so a restore or a sign-in sees the saved accounts
 * (#2039). Reachable from `firebase/auth`, so no top-level await (#697).
 *
 * Nothing waits when there is nothing to wait for: on the worker path, in a
 * Node process or a Service Worker, on a host that injects no page script, and
 * once the runtime has finished loading (`__PYRIC_PAGE_BACKEND_LOADED__`). A
 * page that imports Firestore, Storage or Database finishes loading it before
 * app code runs, so its auth calls run inline, as they did before.
 */
import { useWorker } from './worker-runtime.js';

declare global {
  /** The in-page backend load the page script started (`./page.ts`). */
  // eslint-disable-next-line no-var
  var __PYRIC_PAGE_BACKEND__: Promise<unknown> | undefined;
  /** Set by `./runtime.ts` as its last top-level statement, once it has loaded. */
  // eslint-disable-next-line no-var
  var __PYRIC_PAGE_BACKEND_LOADED__: boolean | undefined;
}

/** The load `pageBackendReady` waits on, and the settled promise it hands out for it. */
let watched: { load: Promise<unknown>; ready: Promise<void> } | null = null;
let settled = false;

/**
 * Resolves once a pending in-page backend load settles; null when nothing is
 * pending. A load that fails warns once and resolves, so auth runs unsaved
 * instead of hanging. Re-read on every call while the page script has not
 * published a load yet.
 */
export function pageBackendReady(): Promise<void> | null {
  if (useWorker) return null;
  if (globalThis.__PYRIC_PAGE_BACKEND_LOADED__ === true) return null;
  const load = globalThis.__PYRIC_PAGE_BACKEND__;
  if (load === undefined) return null;
  if (watched?.load !== load) {
    settled = false;
    watched = {
      load,
      ready: load.then(
        () => { settled = true; },
        (error: unknown) => {
          settled = true;
          console.warn('[pyric sandbox] the in-page backend did not load, so auth on this page does not save or restore its state:', error);
        },
      ),
    };
  }
  return settled ? null : watched.ready;
}

/** Run `task` once a pending load settles; at once when nothing is pending. */
export function runAfterPageBackend(task: () => void): void {
  const ready = pageBackendReady();
  if (ready === null) task();
  else void ready.then(task);
}

/** An async in-page call that runs after a pending load settles, so it sees the saved accounts. */
export function afterPageBackend<Args extends unknown[], Result>(
  call: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return (...args) => {
    const ready = pageBackendReady();
    if (ready === null) return call(...args);
    return ready.then(() => call(...args));
  };
}

/**
 * An in-page listener registered after a pending load settles, so its first
 * callback is the restored session rather than a null that precedes it.
 */
export function subscribeAfterPageBackend<Args extends unknown[]>(
  subscribe: (...args: Args) => () => void,
): (...args: Args) => () => void {
  return (...args) => {
    let unsubscribe: (() => void) | null = null;
    let stopped = false;
    runAfterPageBackend(() => {
      if (!stopped) unsubscribe = subscribe(...args);
    });
    return () => {
      stopped = true;
      unsubscribe?.();
    };
  };
}
