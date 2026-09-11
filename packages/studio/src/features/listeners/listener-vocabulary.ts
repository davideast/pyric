/**
 * The words the Listeners table uses (feature: Listeners).
 *
 * PURE. Everything a reader sees in a cell is phrased in terms of what the
 * app did: `3 deliveries`, `attached 12s ago`, `duplicate ×3`, `reattached
 * 40 times in 10s`. No internal pattern names reach the screen.
 */

import type { ActiveListener } from 'pyric/sandbox';
import type { ActivityIncident } from 'pyric/firestore/internal';

/** A duration as the shortest readable unit: `12s`, `4m`, `2h`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** How long ago something happened, relative to `now`. */
export function formatAgo(at: number, now: number): string {
  return `${formatDuration(now - at)} ago`;
}

/** The `attached` cell. */
export function formatAttached(at: number, now: number): string {
  return `attached ${formatAgo(at, now)}`;
}

/** The `last delivery` cell; a listener that has never delivered says so. */
export function formatLastDelivery(at: number | undefined, now: number): string {
  return at === undefined ? 'no deliveries yet' : formatAgo(at, now);
}

export function formatDeliveries(count: number): string {
  return `${count} ${count === 1 ? 'delivery' : 'deliveries'}`;
}

export function formatSuppressed(count: number): string {
  return `${count} suppressed`;
}

/** The `×N` a collapsed duplicate row carries. */
export function formatDuplicateRow(count: number): string {
  return `duplicate ×${count}`;
}

/** Who issued the operations behind a listener. */
export function formatActor(listener: ActiveListener): string {
  const actor = listener.actor;
  if (actor.kind === 'agent') return `agent ${actor.name}`;
  if (actor.kind === 'app-builder') return 'app builder';
  return actor.kind;
}

/** One incident, in the reader's terms. */
export function formatIncident(incident: ActivityIncident): string {
  if (incident.pattern === 'duplicate-listener') return `duplicate ×${incident.count}`;
  if (incident.pattern === 'listener-churn') {
    return `reattached ${incident.count} times in ${formatDuration(incident.windowMs)}`;
  }
  return `read ${incident.count} times in ${formatDuration(incident.windowMs)}`;
}
