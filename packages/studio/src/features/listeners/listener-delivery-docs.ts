/**
 * What one listener delivered, delivery by delivery (feature: Listeners).
 *
 * PURE. `listener-deliveries.ts` answers when a listener's callback ran; this
 * module answers what the callback received. Both services record the result
 * set on the delivery event, so the document list is a read of the event
 * rather than a query against the store:
 *
 *   - a Firestore `snapshot_delivery` carries `sample.docs`, the documents the
 *     callback saw in order (one entry for a document listener, n for a
 *     query);
 *   - a database `listener` event with `phase: 'delivery'` carries the value at
 *     `target.path`. An object value is a map of child keys, so each key is a
 *     child path under the target; any other value is the target path itself
 *     holding one value.
 *
 * Each path is labelled by comparing the delivery with the previous delivery
 * of the same listener: `added` when the path was not in the previous result,
 * `modified` when it was but its data differs, `unchanged` when it is
 * identical, and `removed` for a path the previous delivery carried and this
 * one does not. A removed path is listed in the delivery that dropped it,
 * which is the only delivery where its absence is news.
 *
 * The fold runs for one listener id at a time. A session holds every event for
 * every listener, and carrying a previous result set for all of them at once
 * would hold the whole store in memory; folding per listener holds one result
 * set instead, which is the one the reader asked about.
 */

import type { SandboxEvent } from 'pyric/sandbox';
import { isDeliveryEvent } from './listener-deliveries.js';

/** How one path changed between the previous delivery and this one. */
export type DeliveryChange = 'added' | 'modified' | 'removed' | 'unchanged';

/** One path in one delivery, as the app's own path string, with its label. */
export interface DeliveredDoc {
  readonly path: string;
  readonly change: DeliveryChange;
}

/** One run of a listener's callback and the result set it received. */
export interface ListenerDelivery {
  readonly at: number;
  /** The listener's first delivery: every path in it is news, so the labels
   *  say nothing the snapshot size does not already say. */
  readonly initial: boolean;
  readonly addedCount: number;
  readonly modifiedCount: number;
  readonly removedCount: number;
  /** Paths the callback received. A removed path is not one of these. */
  readonly size: number;
  /** The result set in the order the callback saw it, then the paths this
   *  delivery dropped. */
  readonly docs: readonly DeliveredDoc[];
}

/** Structural equality over the serializable values a sample carries. */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => sameData(value, b[index]));
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && sameData(left[key], right[key]),
  );
}

/** True for a value whose keys are child paths rather than document fields. */
function isChildMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The result set one delivery event carries, as path/value pairs in order. */
function resultSetOf(event: SandboxEvent): ReadonlyArray<readonly [string, unknown]> {
  if (event.kind === 'snapshot_delivery') {
    const docs = (event as { sample?: { docs?: ReadonlyArray<{ path: string; data: unknown }> } })
      .sample?.docs;
    if (docs === undefined) return [];
    return docs.map((doc) => [doc.path, doc.data] as const);
  }
  const path = (event as { target?: { path?: string } }).target?.path;
  if (path === undefined || path === '') return [];
  const sample = (event as { sample?: unknown }).sample;
  if (sample === undefined || sample === null) return [];
  if (!isChildMap(sample)) return [[path, sample] as const];
  return Object.keys(sample).map((key) => [`${path}/${key}`, sample[key]] as const);
}

/** The counts the delivery event stated, when it stated them. A database
 *  delivery carries a size only, so its counts come from the labels. */
function statedCounts(
  event: SandboxEvent,
): { added: number; modified: number; removed: number } | undefined {
  if (event.kind !== 'snapshot_delivery') return undefined;
  const stated = event as { addedCount?: number; modifiedCount?: number; removedCount?: number };
  if (
    stated.addedCount === undefined ||
    stated.modifiedCount === undefined ||
    stated.removedCount === undefined
  ) {
    return undefined;
  }
  return {
    added: stated.addedCount,
    modified: stated.modifiedCount,
    removed: stated.removedCount,
  };
}

/**
 * Every delivery of one listener, oldest first, each with its labelled paths.
 *
 * The previous result set is the previous delivery of this listener only:
 * a listener's deliveries are a sequence of its own, and interleaved
 * deliveries of other listeners say nothing about what this one received.
 */
export function listenerDeliveryHistory(
  events: readonly SandboxEvent[],
  listenerId: string,
): readonly ListenerDelivery[] {
  const history: ListenerDelivery[] = [];
  let previous = new Map<string, unknown>();
  for (const event of events) {
    if (!isDeliveryEvent(event)) continue;
    if ((event as { listenerId?: string }).listenerId !== listenerId) continue;

    const result = resultSetOf(event);
    const current = new Map<string, unknown>(result.map(([path, data]) => [path, data]));
    const docs: DeliveredDoc[] = [];
    let added = 0;
    let modified = 0;
    for (const [path, data] of result) {
      if (!previous.has(path)) {
        docs.push({ path, change: 'added' });
        added += 1;
      } else if (sameData(previous.get(path), data)) {
        docs.push({ path, change: 'unchanged' });
      } else {
        docs.push({ path, change: 'modified' });
        modified += 1;
      }
    }
    let removed = 0;
    for (const path of previous.keys()) {
      if (current.has(path)) continue;
      docs.push({ path, change: 'removed' });
      removed += 1;
    }

    const stated = statedCounts(event);
    history.push({
      at: event.at,
      initial: history.length === 0,
      addedCount: stated?.added ?? added,
      modifiedCount: stated?.modified ?? modified,
      removedCount: stated?.removed ?? removed,
      size: result.length,
      docs,
    });
    previous = current;
  }
  return history;
}

/** The newest delivery of one listener, or nothing when it has never fired. */
export function latestListenerDelivery(
  events: readonly SandboxEvent[],
  listenerId: string,
): ListenerDelivery | undefined {
  const history = listenerDeliveryHistory(events, listenerId);
  return history[history.length - 1];
}

/** How many distinct paths a listener has delivered across the session. A
 *  path removed and delivered again is one path, not two. */
export function distinctDeliveredPaths(history: readonly ListenerDelivery[]): number {
  const paths = new Set<string>();
  for (const delivery of history) {
    for (const doc of delivery.docs) paths.add(doc.path);
  }
  return paths.size;
}

/** How many documents the listener's deliveries handed the callback in total:
 *  every snapshot's size summed, so a document in ten snapshots is ten. */
export function deliveredDocumentReads(history: readonly ListenerDelivery[]): number {
  let reads = 0;
  for (const delivery of history) reads += delivery.size;
  return reads;
}

/** One path and how many deliveries changed it. */
export interface DeliveredPathCount {
  readonly path: string;
  readonly changes: number;
}

/**
 * Every path the listener delivered, with the number of deliveries that
 * changed it, most-changed first and ties in path order. An unchanged path in
 * a delivery is the same data again, so it does not count; the initial
 * delivery's paths count once, since arriving is the first change.
 */
export function deliveredPathCounts(
  history: readonly ListenerDelivery[],
): readonly DeliveredPathCount[] {
  const changes = new Map<string, number>();
  for (const delivery of history) {
    for (const doc of delivery.docs) {
      const current = changes.get(doc.path) ?? 0;
      changes.set(doc.path, doc.change === 'unchanged' ? current : current + 1);
    }
  }
  return Object.freeze(
    [...changes.entries()]
      .map(([path, count]) => Object.freeze({ path, changes: count }))
      .sort((a, b) => (b.changes - a.changes) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}
