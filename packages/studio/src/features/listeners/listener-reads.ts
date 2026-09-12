/**
 * What one Firestore listener costs to hold (feature: Listeners).
 *
 * PURE. Firestore bills a snapshot listener for the documents it hands the
 * callback the first time, then for each document a later delivery adds or
 * changes. A delivery that only drops documents bills nothing, and a listener
 * whose first result set is empty is still charged one read.
 *
 * The Realtime Database bills by data transferred rather than by document, so
 * nothing here applies to it and its page states no reads.
 */

import type { ListenerDelivery } from './listener-delivery-docs.js';

/**
 * The reads one Firestore listener has cost: its initial snapshot, then the
 * documents added or changed since.
 *
 * This is an estimate over one session's deliveries. A reconnect re-reads the
 * whole result set and a second listener on the same query pays again; neither
 * is visible in the delivery stream, so neither is counted.
 */
export function estimatedDocumentReads(history: readonly ListenerDelivery[]): number {
  const initial = history[0];
  if (initial === undefined) return 0;
  let reads = Math.max(initial.size, 1);
  for (const delivery of history.slice(1)) {
    reads += delivery.addedCount + delivery.modifiedCount;
  }
  return reads;
}
