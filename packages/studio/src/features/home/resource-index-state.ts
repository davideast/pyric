/**
 * The resource index's entries state transition (PURE).
 *
 * A build progressively delivers its results in batches (Firestore first, then
 * users, storage, RTDB — see `buildResourceIndex`). The hook folds each batch
 * into the visible `entries` array. The rule that keeps the Sandbox card's
 * counts honest lives here:
 *
 *   - the FIRST batch of a build REPLACES whatever the last build left, and
 *   - later batches of the SAME build APPEND (progressive fill).
 *
 * This is the fix for the "counts randomly count up rapidly" bug: every worker
 * event re-derives the data source identity, which re-fires the Settings
 * card's `ensure()` effect. A chained rebuild that appended a whole fresh
 * inventory ON TOP of the previous build's entries — every tick — made the
 * counts run away (users:files stuck at an exact 1:2 ratio because each cycle
 * added one full inventory). Making the first batch of each build replace
 * means the counts are always a pure recompute of the LATEST build, no matter
 * how many builds/ticks precede it.
 */

import { resourceEntryIdentity, type ResourceEntry } from './typeahead.js';

export type ResourceIndexUpdate = (previous: ResourceEntry[] | null) => ResourceEntry[];

/**
 * Turn progressive build batches into state updates. Keeping the
 * first-batch replacement rule here lets tests exercise the same deferred
 * updater scheduling React uses in the hook.
 */
export function createIndexBatchPublisher(
  schedule: (update: ResourceIndexUpdate) => void,
): (batch: readonly ResourceEntry[]) => void {
  let firstOfBuild = true;
  return (batch) => {
    // React may apply this updater after the progressive callback returns.
    // Snapshot the decision now instead of closing over the mutable flag.
    const replacePreviousBuild = firstOfBuild;
    firstOfBuild = false;
    schedule((previous) => foldIndexBatch(previous, batch, replacePreviousBuild));
  };
}

function uniqueResources(entries: readonly ResourceEntry[]): ResourceEntry[] {
  const byIdentity = new Map<string, ResourceEntry>();
  for (const entry of entries) byIdentity.set(resourceEntryIdentity(entry), entry);
  return [...byIdentity.values()];
}

export function foldIndexBatch(
  prev: ResourceEntry[] | null,
  batch: readonly ResourceEntry[],
  firstOfBuild: boolean,
): ResourceEntry[] {
  return uniqueResources(firstOfBuild ? batch : [...(prev ?? []), ...batch]);
}
