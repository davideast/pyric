/**
 * One listener's deliveries as the Traffic timeline reads them (feature:
 * Listeners).
 *
 * PURE. The Traffic surface buckets a request buffer into the histogram, brushes
 * one interval, and lists the rows that fall in it. A listener's deliveries are
 * the same shape of evidence over time, so the page feeds the same component
 * rather than drawing a second chart: each delivery becomes one event at its own
 * timestamp, and the brushed interval narrows the rows under the histogram.
 *
 * No delivery is a denial, so every event carries `allow` and the histogram's
 * deny stack stays empty.
 */

import type { TrafficEvent } from '@pyric/ui/traffic';
import type { TimeWindow } from '@pyric/ui/traffic';
import type { ListenerDelivery } from './listener-delivery-docs.js';

/** Every delivery as one timeline event, oldest first. The index keys the
 *  event: two deliveries of one listener can land in the same millisecond. */
export function deliveryTimelineEvents(
  history: readonly ListenerDelivery[],
  path: string,
): TrafficEvent[] {
  return history.map((delivery, index) => ({
    id: `delivery-${index}`,
    at: delivery.at,
    method: 'listen',
    path,
    auth: null,
    result: 'allow',
    reasons: [],
    origin: 'listener',
  }));
}

/** The deliveries inside one half-open interval, the same rule the histogram
 *  buckets by, so a brushed bar and the rows under it agree. */
export function deliveriesInInterval(
  history: readonly ListenerDelivery[],
  window: TimeWindow,
): readonly ListenerDelivery[] {
  return history.filter((delivery) => delivery.at >= window.start && delivery.at < window.end);
}

/**
 * What a brushed interval holds: how many deliveries, and how many documents
 * they added, changed, and dropped. A figure of zero is left out; the delivery
 * count stays, since it is what the interval is.
 */
export function intervalFacts(deliveries: readonly ListenerDelivery[]): readonly string[] {
  let added = 0;
  let modified = 0;
  let removed = 0;
  for (const delivery of deliveries) {
    added += delivery.initial ? delivery.size : delivery.addedCount;
    modified += delivery.initial ? 0 : delivery.modifiedCount;
    removed += delivery.initial ? 0 : delivery.removedCount;
  }
  const count = deliveries.length;
  const facts = [`${count} ${count === 1 ? 'delivery' : 'deliveries'}`];
  if (added > 0) facts.push(`${added} added`);
  if (modified > 0) facts.push(`${modified} modified`);
  if (removed > 0) facts.push(`${removed} removed`);
  return facts;
}

/** The figures one delivery row states: what moved, with no snapshot size —
 *  the row's own column carries that. */
export function deliveryMovement(delivery: ListenerDelivery): string {
  if (delivery.initial) return 'initial';
  const moved: string[] = [];
  if (delivery.addedCount > 0) moved.push(`+${delivery.addedCount}`);
  if (delivery.modifiedCount > 0) moved.push(`~${delivery.modifiedCount}`);
  if (delivery.removedCount > 0) moved.push(`−${delivery.removedCount}`);
  return moved.join(' ');
}
