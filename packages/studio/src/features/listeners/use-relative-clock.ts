/**
 * Ticking relative-age clock for the Listeners feature (`ListenersView` and
 * `ListenerPage`). When `now` is passed explicitly (tests), no interval runs.
 */
import { useEffect, useState } from 'react';

const RELATIVE_CLOCK_TICK_MS = 5_000;

export function useRelativeClock(now?: number): number {
  const [liveClock, setLiveClock] = useState(() => Date.now());

  useEffect(() => {
    if (now !== undefined) return undefined;
    const timer = globalThis.setInterval(() => {
      setLiveClock(Date.now());
    }, RELATIVE_CLOCK_TICK_MS);
    return () => globalThis.clearInterval(timer);
  }, [now]);

  if (now !== undefined) return now;
  return Math.max(liveClock, Date.now());
}
