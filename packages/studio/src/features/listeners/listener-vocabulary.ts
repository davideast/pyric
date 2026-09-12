/**
 * The words the Listeners journal uses (feature: Listeners).
 *
 * PURE. Everything a reader sees in a cell is phrased in terms of what the
 * app did: `24m ago`, `duplicate ×2`, `reattached 40 times in 10s`. No
 * internal pattern names reach the screen.
 */

import type { ActivityIncident } from 'pyric/firestore/internal';

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

/** One incident, in the reader's terms. */
export function formatIncident(incident: ActivityIncident): string {
  if (incident.pattern === 'duplicate-listener') return `duplicate ×${incident.count}`;
  if (incident.pattern === 'listener-churn') {
    return `reattached ${incident.count} times in ${formatDuration(incident.windowMs)}`;
  }
  return `read ${incident.count} times in ${formatDuration(incident.windowMs)}`;
}
