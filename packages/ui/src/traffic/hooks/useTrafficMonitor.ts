import { useEffect, useMemo, useRef, useState } from 'react';
import type { TrafficEvent, TrafficSource } from '../types.js';

export interface UseTrafficMonitorOptions {
  /**
   * The subscription function — `sandbox.onRequest` satisfies this
   * directly. Pass a stable reference; the hook re-subscribes on
   * identity change.
   */
  source: TrafficSource;
  /**
   * Ring-buffer cap. Once exceeded, the oldest events are dropped.
   * Default 5000 (~3 MB worst case — see the traffic-monitor probe
   * findings).
   */
  bufferSize?: number;
  /** Whether the buffer starts paused. Default false. */
  paused?: boolean;
  /**
   * Runs per event before buffering — return a (possibly trimmed)
   * event. Lets the consumer shrink oversized payloads without the
   * library knowing payload semantics. Identity is read fresh on
   * each event, so it need not be memoized.
   */
  transform?: (event: TrafficEvent) => TrafficEvent;
}

export interface TrafficCounts {
  /** Events currently in the buffer. */
  total: number;
  /** Of those, how many were denied. */
  denied: number;
  /** Of those, how many are listener re-evals. */
  listener: number;
}

export interface UseTrafficMonitorResult {
  /** The buffered events, oldest first. */
  events: TrafficEvent[];
  counts: TrafficCounts;
  isPaused: boolean;
  /** Stop appending — incoming events are dropped while paused. */
  pause: () => void;
  /** Resume appending. */
  resume: () => void;
  /** Empty the buffer. */
  clear: () => void;
}

/**
 * Buffers a traffic stream into a capped ring buffer with
 * pause/resume/clear. Decoupled from `@pyric/sandbox` — `source` is
 * just a `(cb) => unsubscribe` function.
 *
 * Pause is consumer-side: while paused, the subscription stays
 * attached but incoming events are dropped (not queued). This
 * matches the probe decision — a `load-test`-shaped session can emit
 * 100k+ events, so queueing-while-paused would defeat the point.
 */
export function useTrafficMonitor({
  source,
  bufferSize = 5000,
  paused = false,
  transform,
}: UseTrafficMonitorOptions): UseTrafficMonitorResult {
  const [events, setEvents] = useState<TrafficEvent[]>([]);
  const [isPaused, setIsPaused] = useState(paused);

  // The subscription callback closes over these once. Refs keep it
  // reading the live values without forcing a re-subscribe.
  const pausedRef = useRef(isPaused);
  pausedRef.current = isPaused;
  const bufferSizeRef = useRef(bufferSize);
  bufferSizeRef.current = bufferSize;
  const transformRef = useRef(transform);
  transformRef.current = transform;

  useEffect(() => {
    const unsubscribe = source((event) => {
      if (pausedRef.current) return;
      const shaped = transformRef.current
        ? transformRef.current(event)
        : event;
      setEvents((prev) => {
        const next = prev.length >= bufferSizeRef.current ? prev.slice(1) : prev.slice();
        next.push(shaped);
        return next;
      });
    });
    return unsubscribe;
  }, [source]);

  const counts = useMemo<TrafficCounts>(() => {
    let denied = 0;
    let listener = 0;
    for (const e of events) {
      if (e.result === 'deny') denied++;
      if (e.origin === 'listener') listener++;
    }
    return { total: events.length, denied, listener };
  }, [events]);

  return {
    events,
    counts,
    isPaused,
    pause: () => setIsPaused(true),
    resume: () => setIsPaused(false),
    clear: () => setEvents([]),
  };
}
