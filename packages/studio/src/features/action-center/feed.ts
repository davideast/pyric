/**
 * Action Center: the live event-feed seam (Wave 2, F1).
 *
 * The reducer ([`./reducer`](./reducer.ts)) is pure; this file is the *source*
 * of `SandboxEvent`s it folds. It is a thin local abstraction so the feature
 * owns its subscription rather than reaching into shared/worker code.
 *
 * THE WIRING (now live, post Wave 2.5)
 * ------------------------------------
 * The SharedWorker DOES expose the sandbox's `onEvent`/`history()` stream over
 * its port: the worker host (`serve/worker/host.ts`) wires `sandbox.onEvent` and
 * delivers `history()` on subscribe, and the worker client exposes
 * `subscribeEvents`. Studio's env adapts that into a `LiveEventFeed`
 * (`clients/worker-live.ts` `workerEventFeed`), reachable as `env.live.feed`.
 *
 * So the feed below is injectable, and `shell/studio-data.ts` resolves it:
 * dev-seed `feedFromSandboxLike` in review, `env.live.feed` under
 * `pyric serve --ui`, and {@link emptyEventFeed} only when neither is present
 * (SSR / no SharedWorker / tests). The view renders its empty state then.
 *
 * The interface is deliberately the same `(cb) => unsubscribe` + `history()`
 * shape `sandbox.onEvent`/`history()` already expose, so an in-process feed (the
 * future `browser` env mode) or a direct sandbox handle satisfies it verbatim.
 */

import type { SandboxEvent } from 'pyric/sandbox';

/**
 * A source of `SandboxEvent`s. Mirrors the sandbox's own surface:
 *   - `history()`: every event so far (for a late subscriber / initial fold).
 *   - `subscribe(cb)`: live events from now on; returns an unsubscribe.
 *
 * `sandbox.onEvent`/`history()` satisfy this directly (in-process); a worker
 * channel or a hosted SSE would implement the same two methods.
 */
export interface EventFeed {
  /** Every event emitted so far. Returns a snapshot; safe to read repeatedly. */
  history(): readonly SandboxEvent[];
  /** Subscribe to subsequent events. Returns an unsubscribe function. */
  subscribe(cb: (event: SandboxEvent) => void): () => void;
}

/**
 * The wired default for `local` mode today: no events, no subscription. The
 * Action Center renders its "no activity yet" empty state. Swap this for a real
 * feed (below) the moment the worker port exposes the event stream.
 */
export function emptyEventFeed(): EventFeed {
  return {
    history: () => [],
    subscribe: () => () => {},
  };
}

/**
 * Build an {@link EventFeed} from anything exposing `onEvent` + `history`, i.e.
 * a `Sandbox` handle, or a future worker-port wrapper that mirrors them. This is
 * the seam the wiring follow-up plugs into; it needs no other change here.
 *
 * Not used by the default `local` wiring yet (the worker doesn't surface the
 * stream; see the file header), but kept as the explicit, tested adapter so the
 * follow-up is a one-line `createActionCenterFeed` swap.
 */
export function feedFromSandboxLike(source: {
  history(): readonly SandboxEvent[];
  onEvent(cb: (event: SandboxEvent) => void): () => void;
}): EventFeed {
  return {
    history: () => source.history(),
    subscribe: (cb) => source.onEvent(cb),
  };
}

/**
 * Superseded. The worker-backed feed now lives in `clients/worker-live.ts`
 * (`workerEventFeed`), reached via `env.live.feed`; `shell/studio-data.ts` wires
 * it. This placeholder remains only to fail loudly if old code still calls it,
 * pointing at the real seam.
 */
export function makeWorkerEventFeed(): EventFeed {
  throw new Error(
    'makeWorkerEventFeed is superseded: use env.live.feed (clients/worker-live.ts ' +
      'workerEventFeed), resolved by shell/studio-data.ts useStudioEventFeed / ' +
      'useStudioEvents.',
  );
}
