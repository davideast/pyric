/**
 * When React finished rendering, and whether there is a React on the page at
 * all.
 *
 * React calls `onCommitFiberRoot` on `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`
 * after every commit, and reads that global once, while its own module is
 * first evaluated. So the hook has to be installed before the application's
 * script runs: the served page puts pyric's init tag ahead of the
 * application's module script for exactly this.
 *
 * The React DevTools extension installs the same global. When it got there
 * first this module wraps the hook's `onCommitFiberRoot` rather than replacing
 * it, so the extension keeps working and the panel keeps its data.
 *
 * Everything here is guarded. No React, no hook, or a hook shaped differently
 * from the one this module knows leaves the commit source unavailable with a
 * reason to show, and nothing throws.
 */

/** The hook fields this module reads and writes. */
interface DevToolsHook {
  renderers?: Map<unknown, unknown>;
  supportsFiber?: boolean;
  inject?: (renderer: unknown) => number;
  onCommitFiberRoot?: (...args: unknown[]) => void;
  onPostCommitFiberRoot?: (...args: unknown[]) => void;
  onCommitFiberUnmount?: (...args: unknown[]) => void;
  checkDCE?: (fn: unknown) => void;
}

interface HookWindow {
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook;
  document?: { querySelector?: unknown };
}

/** The commit source the flow mode reads. */
export interface ReactCommitSource {
  /** `true` once a React renderer has injected itself into the hook. */
  available(): boolean;
  /** Why the flow mode is unavailable, or `null` when it is available. */
  reason(): string | null;
  /** Called after every commit, until the returned function is called. */
  subscribe(listener: () => void): () => void;
  /** Give the hook back the handler it had, and drop every subscriber. */
  dispose(): void;
}

/** The global name React reads to find the hook. */
const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

const NO_REACT = 'No React renderer on this page, so there is nothing to follow a delivery into.';
const NOT_INSTALLED = 'The commit hook could not be installed on this page.';

/**
 * `true` when some element on the page carries the property React puts on the
 * host nodes it creates. A page whose React loaded before the hook was
 * installed still answers `true` here, which is how the chip tells "no React"
 * apart from "React, but this source never saw its commits".
 */
export function reactRendered(documentLike: Document | null | undefined): boolean {
  if (documentLike === null || documentLike === undefined) return false;
  let elements: ArrayLike<Element>;
  try {
    elements = documentLike.querySelectorAll('*');
  } catch {
    return false;
  }
  for (let index = 0; index < elements.length; index += 1) {
    const record = elements[index] as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactContainer$')) return true;
    }
  }
  return false;
}

/** A hook object with the members React checks for before it injects. */
function freshHook(): DevToolsHook {
  let nextId = 1;
  const renderers = new Map<unknown, unknown>();
  return {
    renderers,
    supportsFiber: true,
    inject(renderer: unknown) {
      const id = nextId;
      nextId += 1;
      renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot() {},
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    checkDCE() {},
  };
}

/**
 * Install or wrap the commit hook on this window.
 *
 * Call this before the application's script runs. Calling it after React has
 * already loaded leaves a source that never reports a commit, which
 * {@link ReactCommitSource.reason} says.
 */
export function installReactCommitSource(target: unknown): ReactCommitSource {
  const listeners = new Set<() => void>();
  const view = target as HookWindow | null;
  if (view === null || typeof view !== 'object') {
    return {
      available: () => false,
      reason: () => NOT_INSTALLED,
      subscribe: () => () => {},
      dispose: () => {},
    };
  }

  let hook: DevToolsHook;
  let installed = false;
  try {
    const existing = view[HOOK_KEY];
    hook = existing !== null && typeof existing === 'object' ? existing : freshHook();
    if (view[HOOK_KEY] !== hook) view[HOOK_KEY] = hook;
    installed = true;
  } catch {
    return {
      available: () => false,
      reason: () => NOT_INSTALLED,
      subscribe: () => () => {},
      dispose: () => {},
    };
  }

  const previous = hook.onCommitFiberRoot;
  const wrapped = (...args: unknown[]): void => {
    // The extension's own handler runs first and unchanged; a subscriber that
    // throws must not take React's commit down with it.
    try {
      previous?.apply(hook, args);
    } catch {
      /* the extension's handler owns its own failures */
    }
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* one subscriber's failure is not React's problem */
      }
    }
  };
  try {
    hook.onCommitFiberRoot = wrapped;
  } catch {
    installed = false;
  }

  const rendererCount = (): number => {
    const renderers = hook.renderers;
    if (renderers === null || renderers === undefined) return 0;
    return typeof renderers.size === 'number' ? renderers.size : 0;
  };

  return {
    available() {
      return installed && rendererCount() > 0;
    },
    reason() {
      if (!installed) return NOT_INSTALLED;
      if (rendererCount() === 0) return NO_REACT;
      return null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      listeners.clear();
      if (hook.onCommitFiberRoot === wrapped) hook.onCommitFiberRoot = previous;
    },
  };
}
