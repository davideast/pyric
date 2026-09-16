/** The hook fields this module reads and writes. */
export interface DevToolsHook {
  renderers?: Map<unknown, unknown>;
  supportsFiber?: boolean;
  inject?: (renderer: unknown) => number;
  onCommitFiberRoot?: (...args: unknown[]) => void;
  onPostCommitFiberRoot?: (...args: unknown[]) => void;
  onCommitFiberUnmount?: (...args: unknown[]) => void;
  checkDCE?: (fn: unknown) => void;
}

export interface HookWindow {
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook;
  document?: { querySelector?: unknown };
}

/**
 * Register before React evaluates; the later commit source subscribes to this hook.
 * Keep this function self-contained: the HTML bootstrap serialises its compiled
 * JavaScript so the browser and late-install fallback share one implementation.
 */
export function ensureReactHook(view: HookWindow): DevToolsHook {
  const existing = view.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const hasHook = existing !== null && typeof existing === 'object';
  if (hasHook) return existing;
  const renderers = new Map<unknown, unknown>();
  let nextId = 1;
  const hook: DevToolsHook = {
    renderers,
    supportsFiber: true,
    inject(renderer: unknown) {
      const id = nextId++;
      renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot() {},
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    checkDCE() {},
  };
  view.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  return hook;
}
