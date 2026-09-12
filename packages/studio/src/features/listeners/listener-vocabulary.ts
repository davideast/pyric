/**
 * The durations the Listeners surfaces write (feature: Listeners).
 *
 * PURE. A time on screen is always how long ago something happened, in the
 * shortest unit that reads: `12s`, `4m`, `2h`. No internal pattern name and no
 * timestamp format reaches a cell.
 */

/** A duration as the shortest readable unit: `12s`, `4m`, `2h`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** How long ago something happened, relative to `now`: the `attached` cell. */
export function formatAgo(at: number, now: number): string {
  return `${formatDuration(now - at)} ago`;
}
