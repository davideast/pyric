/**
 * Time-window calculation for the Traffic surface and its subtabs.
 *
 * Keeps Sandbox Mode's exact window bounds unchanged while extending Live Mode's
 * upper bound past `now` when empty or when observed client timestamps lead the
 * browser clock slightly, so `[start, end)` half-open bucketing never drops
 * fresh live deliveries.
 */
import type { TimeWindow } from '@pyric/ui/traffic';

export function computeTrafficWindow(
  events: readonly { readonly at: number }[],
  isLiveHost: boolean,
  now = Date.now(),
): TimeWindow {
  if (events.length === 0) {
    return {
      start: now - 15 * 60_000,
      end: isLiveHost ? now + 1_000 : now,
    };
  }
  let earliest = Infinity;
  let latest = now;
  for (const event of events) {
    if (event.at < earliest) earliest = event.at;
    if (isLiveHost && event.at > latest) latest = event.at;
  }
  return {
    start: Math.min(earliest, now - 60_000),
    end: (isLiveHost ? latest : now) + 1_000,
  };
}
