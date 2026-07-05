import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivitySource, AnyActivityEvent } from '../types.js';

export interface UseActivityStreamOptions {
  /**
   * The subscription — `sandbox.onEvent` satisfies this directly. Pass
   * a stable reference; the hook re-subscribes on identity change.
   */
  source: ActivitySource;
  /**
   * Seed the buffer with a snapshot before the live subscription
   * attaches — typically `sandbox.history()`, so a late-attaching
   * consumer sees the whole session, not just events from `subscribe`
   * onward. Read once on mount.
   */
  initial?: readonly AnyActivityEvent[];
  /**
   * Ring-buffer cap. Once exceeded, the oldest events drop. Default
   * 5000 (mirrors the traffic monitor's cap — a load-test session can
   * emit 100k+ events).
   */
  bufferSize?: number;
  /** Start paused — incoming events drop (not queued) while paused. */
  paused?: boolean;
}

export interface UseActivityStreamResult {
  /** The buffered events, oldest-first. Stable per emission — safe to
   *  hand straight to {@link useActivityDigest}. */
  events: AnyActivityEvent[];
  isPaused: boolean;
  pause: () => void;
  resume: () => void;
  /** Empty the buffer (does NOT re-seed from `initial`). */
  clear: () => void;
}

/**
 * Buffers the unified sandbox event stream into a capped ring buffer
 * with optional history seeding + pause/resume/clear. Decoupled from
 * `pyric` — `source` is just a `(cb) => unsubscribe`.
 *
 * Sibling to the traffic monitor's `useTrafficMonitor`; the difference
 * is the wider event type (`AnyActivityEvent`, the full union) and the
 * `initial` seed so `history()` + live compose into one buffer.
 */
export function useActivityStream({
  source,
  initial,
  bufferSize = 5000,
  paused = false,
}: UseActivityStreamOptions): UseActivityStreamResult {
  const [events, setEvents] = useState<AnyActivityEvent[]>(() =>
    initial ? initial.slice(-bufferSize) : [],
  );
  const [isPaused, setIsPaused] = useState(paused);

  const pausedRef = useRef(isPaused);
  pausedRef.current = isPaused;
  const bufferSizeRef = useRef(bufferSize);
  bufferSizeRef.current = bufferSize;

  useEffect(() => {
    const unsubscribe = source((event) => {
      if (pausedRef.current) return;
      setEvents((prev) => {
        const next =
          prev.length >= bufferSizeRef.current ? prev.slice(1) : prev.slice();
        next.push(event);
        return next;
      });
    });
    return unsubscribe;
  }, [source]);

  return useMemo(
    () => ({
      events,
      isPaused,
      pause: () => setIsPaused(true),
      resume: () => setIsPaused(false),
      clear: () => setEvents([]),
    }),
    [events, isPaused],
  );
}
