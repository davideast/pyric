/**
 * What one listener delivered, delivery by delivery (feature: Listeners).
 *
 * PURE. `listener-deliveries.ts` answers when a listener's callback ran; this
 * module answers what the callback received. Sandbox and live events both carry
 * enough structure on the delivery event to fold per-path movement without
 * querying the store:
 *
 *   - a Firestore `snapshot_delivery` carries `sample.docs`, the documents the
 *     callback saw in order (one entry for a document listener, n for a
 *     query);
 *   - a database `listener` event with `phase: 'delivery'` carries the value at
 *     `target.path`. An object value is a map of child keys, so each key is a
 *     child path under the target; any other value is the target path itself
 *     holding one value;
 *   - a live `operation` delivery carries `detail.delivery`
 *     (`ObservedDeliverySummary`: `mode: 'snapshot' | 'delta'`, uncapped `size`,
 *     bounded `paths`, and optional `removedPaths`, value-free). Delta
 *     listeners (`onSnapshot`, `onChild*`) report incremental path changes,
 *     while full-node RTDB `onValue` listeners report the present child key set.
 *
 * Each path is labelled by comparing the delivery with the previous delivery
 * of the same listener:
 *   - sandbox deliveries carry values and label `added`, `modified`, `unchanged`,
 *     and `removed` by structural comparison;
 *   - live delta deliveries (`onSnapshot`, `onChild*`) label path additions,
 *     modifications, unchanged carryover, and dropped `removed` paths;
 *   - live full-node RTDB `onValue` summaries carry present child keys without
 *     values, so keys label `added` or `unchanged` (and dropped keys `removed`)
 *     without speculating `modified`.
 * A removed path is listed in the delivery that dropped it, which is the only
 * delivery where its absence is news.
 *
 * The fold runs for one listener id at a time. A session holds every event for
 * every listener, and carrying a previous result set for all of them at once
 * would hold the whole store in memory; folding per listener holds one result
 * set instead, which is the one the reader asked about.
 */

import type { ObservedDeliverySummary, SandboxEvent } from 'pyric/sandbox';
import {
  isFirestoreDocumentPath,
  observedDeliveryOf,
  trimObservedPath,
} from 'pyric/sandbox/internal';
import { deliveryListenerId, isDeliveryEvent } from './listener-deliveries.js';

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
  /** Measured Firestore document reads for this delivery when reported by `@pyric/live`. */
  readonly billedDocuments?: number;
  /** The result set in the order the callback saw it, then the paths this
   *  delivery dropped. */
  readonly docs: readonly DeliveredDoc[];
}

const SERVICE_SENTINEL_PATH = '(service)';

const RTDB_CHILD_LISTENER_METHODS = new Set([
  'onChildAdded',
  'onChildChanged',
  'onChildMoved',
  'onChildRemoved',
]);

function makeListenerDelivery(fields: {
  at: number;
  initial: boolean;
  addedCount: number;
  modifiedCount: number;
  removedCount: number;
  size: number;
  docs: readonly DeliveredDoc[];
  billedDocuments?: number;
}): ListenerDelivery {
  const delivery: ListenerDelivery = {
    at: fields.at,
    initial: fields.initial,
    addedCount: fields.addedCount,
    modifiedCount: fields.modifiedCount,
    removedCount: fields.removedCount,
    size: fields.size,
    docs: fields.docs,
  };
  if (fields.billedDocuments !== undefined) {
    return { ...delivery, billedDocuments: fields.billedDocuments };
  }
  return delivery;
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

/** The result set one sandbox delivery event carries, as path/value pairs in order. */
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

/** The counts the delivery event stated, when it stated them. */
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

function cleanPaths(paths: readonly string[] | undefined): string[] {
  if (paths === undefined) return [];
  return paths.map(trimObservedPath).filter((entry) => entry !== '');
}

function fallbackDocPaths(path: string | undefined, service: string): string[] {
  if (path === undefined || path === '' || path === SERVICE_SENTINEL_PATH) return [];
  const clean = trimObservedPath(path);
  if (clean === '') return [];
  if (service === 'rtdb') return [clean];
  return isFirestoreDocumentPath(clean) ? [clean] : [];
}

interface LiveFoldState {
  readonly paths: Set<string>;
  readonly uncappedSize: number;
}

function foldLiveDeltaDelivery(
  event: Extract<SandboxEvent, { kind: 'operation' }>,
  summary: ObservedDeliverySummary | undefined,
  previous: LiveFoldState,
  initial: boolean,
): { delivery: ListenerDelivery; next: LiveFoldState } {
  const service = event.service ?? 'firestore';
  const billed = event.production?.billedDocuments;
  let rawPaths: string[];
  if (summary !== undefined) {
    rawPaths = cleanPaths(summary.paths);
  } else if (billed === 0) {
    rawPaths = [];
  } else {
    rawPaths = fallbackDocPaths(event.path, service);
  }
  const removedList = cleanPaths(summary?.removedPaths);
  const removedSet = new Set(removedList);
  const changedSet = new Set(rawPaths);

  const nextPaths = new Set<string>();
  const docs: DeliveredDoc[] = [];
  let added = 0;
  let modified = 0;
  let removed = 0;

  for (const prevPath of previous.paths) {
    if (removedSet.has(prevPath)) continue;
    nextPaths.add(prevPath);
    if (changedSet.has(prevPath)) {
      docs.push({ path: prevPath, change: 'modified' });
      modified += 1;
    } else {
      docs.push({ path: prevPath, change: 'unchanged' });
    }
  }
  for (const path of rawPaths) {
    if (previous.paths.has(path) || removedSet.has(path) || nextPaths.has(path)) continue;
    nextPaths.add(path);
    docs.push({ path, change: 'added' });
    added += 1;
  }
  let remainingPreviousUntracked = Math.max(0, previous.uncappedSize - previous.paths.size);
  for (const path of removedSet) {
    if (previous.paths.has(path)) {
      docs.push({ path, change: 'removed' });
      removed += 1;
    } else if (remainingPreviousUntracked > 0) {
      docs.push({ path, change: 'removed' });
      removed += 1;
      remainingPreviousUntracked -= 1;
    }
  }

  // Preserve true cardinality when a snapshot exceeds the 64-path wire cap.
  let untrackedInDelta = 0;
  if (summary !== undefined) {
    untrackedInDelta = Math.max(0, summary.size - rawPaths.length);
  }
  if (untrackedInDelta > 0) {
    if (initial) added += untrackedInDelta;
    else modified += untrackedInDelta;
  }
  let size = nextPaths.size + remainingPreviousUntracked;
  if (initial) size += untrackedInDelta;
  if (initial && summary !== undefined) {
    size = Math.max(size, summary.size);
  }

  const hasEmptySummary =
    summary === undefined ||
    (summary.size === 0 && rawPaths.length === 0 && removedList.length === 0);
  if (docs.length === 0 && hasEmptySummary && billed !== undefined && billed > 0) {
    if (initial) {
      added = billed;
      size = billed;
    } else {
      modified = billed;
      size = Math.max(previous.uncappedSize, billed);
    }
  }

  let billedDocuments: number | undefined;
  if (service === 'firestore') billedDocuments = billed;
  return {
    delivery: makeListenerDelivery({
      at: event.at,
      initial,
      addedCount: added,
      modifiedCount: modified,
      removedCount: removed,
      size,
      docs,
      billedDocuments,
    }),
    next: { paths: nextPaths, uncappedSize: size },
  };
}

function foldLiveSnapshotDelivery(
  event: Extract<SandboxEvent, { kind: 'operation' }>,
  summary: ObservedDeliverySummary | undefined,
  previous: LiveFoldState,
  initial: boolean,
): { delivery: ListenerDelivery; next: LiveFoldState } {
  let presentPaths: string[];
  if (summary !== undefined) {
    presentPaths = cleanPaths(summary.paths);
  } else {
    presentPaths = fallbackDocPaths(event.path, 'rtdb');
  }
  const presentSet = new Set(presentPaths);
  const docs: DeliveredDoc[] = [];
  let added = 0;
  let removed = 0;

  // Live RTDB `onValue` summaries carry child keys without field values, so
  // keys already present stay `unchanged` rather than speculating `modified`.
  for (const path of presentPaths) {
    if (!previous.paths.has(path)) {
      docs.push({ path, change: 'added' });
      added += 1;
    } else {
      docs.push({ path, change: 'unchanged' });
    }
  }
  for (const path of previous.paths) {
    if (presentSet.has(path)) continue;
    docs.push({ path, change: 'removed' });
    removed += 1;
  }

  let size = presentPaths.length;
  if (summary !== undefined) size = summary.size;
  let untrackedInitial = 0;
  if (initial) untrackedInitial = Math.max(0, size - presentPaths.length);
  return {
    delivery: makeListenerDelivery({
      at: event.at,
      initial,
      addedCount: added + untrackedInitial,
      modifiedCount: 0,
      removedCount: removed,
      size,
      docs,
    }),
    next: { paths: presentSet, uncappedSize: size },
  };
}

function isLiveDeltaEvent(
  event: Extract<SandboxEvent, { kind: 'operation' }>,
  summary: ObservedDeliverySummary | undefined,
): boolean {
  if (summary !== undefined) return summary.mode === 'delta';
  if ((event.service ?? 'firestore') !== 'rtdb') return true;
  return RTDB_CHILD_LISTENER_METHODS.has(event.method);
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
  let liveState: LiveFoldState = { paths: new Set<string>(), uncappedSize: 0 };

  for (const event of events) {
    if (!isDeliveryEvent(event)) continue;
    if (deliveryListenerId(event) !== listenerId) continue;

    if (event.kind === 'operation') {
      const summary = observedDeliveryOf(event);
      const initial = history.length === 0;
      let folded: { delivery: ListenerDelivery; next: LiveFoldState };
      if (isLiveDeltaEvent(event, summary)) {
        folded = foldLiveDeltaDelivery(event, summary, liveState, initial);
      } else {
        folded = foldLiveSnapshotDelivery(event, summary, liveState, initial);
      }
      history.push(folded.delivery);
      liveState = folded.next;
      continue;
    }

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
    history.push(
      makeListenerDelivery({
        at: event.at,
        initial: history.length === 0,
        addedCount: stated?.added ?? added,
        modifiedCount: stated?.modified ?? modified,
        removedCount: stated?.removed ?? removed,
        size: result.length,
        docs,
      }),
    );
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
