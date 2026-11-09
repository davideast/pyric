/**
 * What one Firestore listener costs to hold (feature: Listeners).
 *
 * PURE. Firestore bills a snapshot listener for the documents it hands the
 * callback the first time, then for each document a later delivery adds or
 * changes. A delivery that only drops documents bills nothing, and a listener
 * whose first result set is empty is still charged one read. When `@pyric/live`
 * recorded exact `billedDocuments` on a live delivery (including snapshots
 * larger than the 64-path display cap or metadata-only snapshots), that
 * measured count takes precedence.
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
  const initialCount = initial.billedDocuments ?? initial.size;
  let reads = Math.max(initialCount, 1);
  for (const delivery of history.slice(1)) {
    if (delivery.billedDocuments !== undefined) {
      reads += delivery.billedDocuments;
    } else {
      reads += delivery.addedCount + delivery.modifiedCount;
    }
  }
  return reads;
}
