/**
 * One listener's page, as sentences and card totals (feature: Listeners).
 *
 * PURE, the way `listener-story.ts` is pure for the tab: the fold hands over
 * facts, this module turns them into the journal header and the three cards.
 *
 * The headline is the target the app wrote. The listener id is not in it and
 * not anywhere else on the page — the route carries the id, and a reader
 * looking for a listener is looking for a path, not a handle.
 */

import type { MetricSeries } from '@pyric/ui/traffic';
import type { ActiveListener } from 'pyric/sandbox';
import { formatListenerTarget, groupIdentityFor } from './listener-groups.js';
import { formatDuration } from './listener-vocabulary.js';

/** The service in the voice of a sentence rather than an event token. */
function serviceLabel(service: ActiveListener['service']): string {
  return service === 'firestore' ? 'Firestore' : 'Database';
}

export interface ListenerPageHeader {
  readonly eyebrow: string;
  readonly headline: string;
  readonly finding: string;
}

/** The journal header for one listener: what it watches, who holds it, how
 *  long it has been attached, and which backend answers it. */
export function listenerPageHeader(
  listener: ActiveListener,
  now: number,
): ListenerPageHeader {
  return {
    eyebrow: 'Listener',
    headline: formatListenerTarget(listener.target),
    finding: `Held by ${groupIdentityFor(listener).label} · attached ${formatDuration(
      now - listener.attachedAt,
    )} ago · ${serviceLabel(listener.service)}`,
  };
}

export interface ListenerPageTotals {
  /** Deliveries recorded for this listener in the session. */
  readonly deliveries: number;
  /** Distinct paths the listener has delivered. */
  readonly documents: number;
  /** Re-evals the sandbox resolved to no observable change. */
  readonly suppressed: number;
}

const PAGE_CARD_DEFS: ReadonlyArray<{ key: keyof ListenerPageTotals; label: string }> = [
  { key: 'deliveries', label: 'Deliveries' },
  { key: 'documents', label: 'Documents' },
  { key: 'suppressed', label: 'Suppressed' },
];

/** The card strip. `values` is empty by design: each card is a count of
 *  things that happened, not a line on the chart below it. */
export function listenerPageCards(totals: ListenerPageTotals): MetricSeries[] {
  return PAGE_CARD_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    values: [],
    total: totals[def.key],
  }));
}

/** One delivery's counts, in the log's mono shorthand. */
export function formatDeliveryCounts(delivery: {
  addedCount: number;
  modifiedCount: number;
  removedCount: number;
}): string {
  return `+${delivery.addedCount} ~${delivery.modifiedCount} -${delivery.removedCount}`;
}

/** How many documents a delivery handed the callback, in words. */
export function formatDocumentCount(size: number): string {
  return `${size} document${size === 1 ? '' : 's'}`;
}
