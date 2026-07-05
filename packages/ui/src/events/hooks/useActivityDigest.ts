import { useMemo } from 'react';
import type { AnyActivityEvent } from '../types.js';
import {
  computeActivityDigest,
  type ActivityDigest,
  type ActivityDigestOptions,
} from '../digest.js';

export interface UseActivityDigestOptions extends ActivityDigestOptions {
  /**
   * Clock injection for the relative `when` column. Defaults to
   * `Date.now()` read once per recompute. Pass a fixed value (or a
   * frozen "session now") for deterministic rendering / tests.
   *
   * NOTE: changing `now` between renders re-folds the digest, so don't
   * pass a fresh `Date.now()` inline unless you want a recompute every
   * render — pin it (e.g. a ticking value updated on an interval).
   */
  now?: number;
}

/**
 * React wrapper over {@link computeActivityDigest} — memoizes the pure
 * fold over the unified `SandboxEvent` stream into the banded activity
 * digest. Feed it `sandbox.history()` (a snapshot) or the live buffer
 * from {@link useActivityStream}; the reducer is identical either way.
 *
 * The fold re-runs when `events` identity, any grouping option, or
 * `now` changes. Keep `events` referentially stable across renders that
 * shouldn't recompute (the stream hook already returns a stable array
 * per emission).
 */
export function useActivityDigest(
  events: readonly AnyActivityEvent[],
  options: UseActivityDigestOptions = {},
): ActivityDigest {
  const { order, groupBy, rowsPerBand, now } = options;
  return useMemo(
    () => computeActivityDigest(events, { order, groupBy, rowsPerBand, now }),
    [events, order, groupBy, rowsPerBand, now],
  );
}
