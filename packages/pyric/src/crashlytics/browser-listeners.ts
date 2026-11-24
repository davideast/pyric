/**
 * Browser DOM event listeners (`error`, `unhandledrejection`, `visibilitychange`,
 * `pagehide`, `popstate`, `hashchange`) and rethrown-error deduplication for
 * `pyric/crashlytics`.
 */
import type { CrashlyticsBreadcrumb, PlainCrashlyticsValue } from './types.js';

const ALREADY_LOGGED_FLAG = Symbol('firebase_crashlytics_logged');
const loggedErrorObjects = new WeakSet<object>();

interface GlobalWindowEventTarget {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
  location?: { pathname?: string; hash?: string };
}

interface GlobalDocumentEventTarget {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  visibilityState?: string;
}

export interface BrowserCrashlyticsHooks {
  isDeleted(): boolean;
  breadcrumbsEnabled: boolean;
  appendBreadcrumb(
    message: string,
    attributes?: Record<string, PlainCrashlyticsValue>,
  ): void;
  recordUnhandledError(error: unknown): void;
  flushOnHide(): void;
}

/**
 * Stamps object errors so caught-and-rethrown exceptions (for example from a
 * framework error boundary) are not recorded a second time by `window` listeners.
 */
export function markErrorAsLogged(error: unknown): void {
  if (typeof error !== 'object' || error === null) {
    return;
  }
  loggedErrorObjects.add(error);
  if (Object.isExtensible(error)) {
    try {
      (error as Record<symbol, unknown>)[ALREADY_LOGGED_FLAG] = true;
    } catch (assignErr) {
      // Frozen or proxy-guarded error objects stay tracked via loggedErrorObjects.
      void assignErr;
    }
  }
}

function isErrorAlreadyLogged(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if (loggedErrorObjects.has(error)) {
    return true;
  }
  return (
    ALREADY_LOGGED_FLAG in error &&
    (error as Record<symbol, unknown>)[ALREADY_LOGGED_FLAG] === true
  );
}

export function pushBoundedBreadcrumb(
  buffer: CrashlyticsBreadcrumb[],
  crumb: CrashlyticsBreadcrumb,
  maxEntries: number,
): void {
  buffer.push(crumb);
  while (buffer.length > maxEntries) {
    buffer.shift();
  }
}

export function attachUnhandledErrorListeners(hooks: BrowserCrashlyticsHooks): () => void {
  const win = (globalThis as { window?: GlobalWindowEventTarget }).window;
  if (
    win === undefined ||
    typeof win.addEventListener !== 'function' ||
    typeof win.removeEventListener !== 'function'
  ) {
    return () => {};
  }

  const onWindowError = (event: unknown): void => {
    if (hooks.isDeleted()) {
      return;
    }
    let extracted: unknown = event;
    if (typeof event === 'object' && event !== null) {
      const rec = event as Record<string, unknown>;
      if ('error' in rec && rec.error !== undefined) {
        extracted = rec.error;
      } else if (typeof rec.message === 'string') {
        extracted = new Error(rec.message);
      }
    }
    if (isErrorAlreadyLogged(extracted)) {
      return;
    }
    markErrorAsLogged(extracted);
    hooks.recordUnhandledError(extracted);
  };

  const onUnhandledRejection = (event: unknown): void => {
    if (hooks.isDeleted()) {
      return;
    }
    let reason: unknown = event;
    if (typeof event === 'object' && event !== null && 'reason' in event) {
      reason = (event as { reason?: unknown }).reason;
    }
    if (isErrorAlreadyLogged(reason)) {
      return;
    }
    markErrorAsLogged(reason);
    hooks.recordUnhandledError(reason);
  };

  win.addEventListener('error', onWindowError);
  win.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    win.removeEventListener?.('error', onWindowError);
    win.removeEventListener?.('unhandledrejection', onUnhandledRejection);
  };
}

export function attachPageLifecycleListeners(hooks: BrowserCrashlyticsHooks): () => void {
  const cleanups: Array<() => void> = [];
  const win = (globalThis as { window?: GlobalWindowEventTarget }).window;
  if (
    win !== undefined &&
    typeof win.addEventListener === 'function' &&
    typeof win.removeEventListener === 'function'
  ) {
    if (hooks.breadcrumbsEnabled) {
      const onNavigation = (): void => {
        if (hooks.isDeleted()) {
          return;
        }
        const pathname = win.location?.pathname ?? '/';
        hooks.appendBreadcrumb(`navigation:${pathname}`, {
          source: 'navigation',
          path: pathname,
        });
      };
      win.addEventListener('popstate', onNavigation);
      win.addEventListener('hashchange', onNavigation);
      cleanups.push(() => {
        win.removeEventListener?.('popstate', onNavigation);
        win.removeEventListener?.('hashchange', onNavigation);
      });
    }

    const onPageHide = (): void => {
      if (hooks.isDeleted()) {
        return;
      }
      hooks.flushOnHide();
    };
    win.addEventListener('pagehide', onPageHide);
    cleanups.push(() => {
      win.removeEventListener?.('pagehide', onPageHide);
    });
  }

  const doc = (globalThis as { document?: GlobalDocumentEventTarget }).document;
  if (
    doc !== undefined &&
    typeof doc.addEventListener === 'function' &&
    typeof doc.removeEventListener === 'function'
  ) {
    const onVisibility = (): void => {
      if (hooks.isDeleted()) {
        return;
      }
      const vis = doc.visibilityState ?? 'unknown';
      if (hooks.breadcrumbsEnabled) {
        hooks.appendBreadcrumb(`visibility:${vis}`, {
          source: 'visibilitychange',
          visibilityState: vis,
        });
      }
      if (vis === 'hidden') {
        hooks.flushOnHide();
      }
    };
    doc.addEventListener('visibilitychange', onVisibility);
    cleanups.push(() => {
      doc.removeEventListener?.('visibilitychange', onVisibility);
    });
  }

  return () => {
    for (const fn of cleanups) {
      fn();
    }
  };
}
