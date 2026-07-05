import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// React 18+ requires this flag for `act()` to behave correctly.
// We set it once at module load — both the firestore-hook tests and
// any future hook tests import this helper.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * DOM-free hook test harness for `@pyric/ui`.
 *
 * `@testing-library/react`'s `renderHook` mounts to a real DOM
 * container, which requires JSDOM globals on `globalThis`. Installing
 * those globals fights `@pyric/firestore-rules`' OHM parser (the
 * rules parser hits cross-realm checks and fails with
 * `Failed to parse rules source`). `react-test-renderer` runs hooks
 * the same way React does internally but doesn't need a DOM at all,
 * so we use it for the firestore subscription hook tests.
 */
export interface HookRenderResult<T, P> {
  /** Current value returned by the hook. Access as `result.current`. */
  result: { current: T };
  /** Re-render the hook with new props. */
  rerender: (props: P) => void;
  /** Unmount the hook's host component. Fires cleanup effects. */
  unmount: () => void;
}

export function renderHook<T, P>(
  hook: (props: P) => T,
  initialProps?: P,
): HookRenderResult<T, P> {
  const result: { current: T } = { current: undefined as T };

  let setProps: ((next: P) => void) | null = null;

  function HookHost({ initial }: { initial: P }) {
    const [props, setLocalProps] = useState<P>(initial);
    setProps = setLocalProps;
    result.current = hook(props);
    return null;
  }

  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = create(<HookHost initial={initialProps as P} />);
  });

  return {
    result,
    rerender(next: P) {
      act(() => {
        setProps?.(next);
      });
    },
    unmount() {
      act(() => {
        renderer?.unmount();
      });
    },
  };
}

/**
 * Mirror of `@testing-library/react`'s `waitFor` — poll a callback
 * until it returns without throwing, or the timeout elapses.
 */
export async function waitFor(
  cb: () => void | Promise<void>,
  opts: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 1000;
  const interval = opts.interval ?? 10;
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeout) {
    try {
      await cb();
      return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw lastErr instanceof Error ? lastErr : new Error('waitFor timed out');
}

export { act };
