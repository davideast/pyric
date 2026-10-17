/**
 * The `.info` tree the web hosted client serves itself (ADR-0019, 2026-10-16
 * amendment). Value, single-event and child listeners and one-time reads on a
 * path under `/.info` are answered here; they never reach the host and are not
 * replayed on re-attach.
 *
 * | Path                     | Value                              |
 * | ------------------------ | ---------------------------------- |
 * | `/.info/connected`       | `true` or `false`                  |
 * | `/.info/serverTimeOffset`| `0`                                |
 * | `/.info`                 | `{ connected, serverTimeOffset: 0 }` |
 * | any other `.info` path   | `null`                             |
 */
import { executeQuery, isInfoPath } from 'pyric/database/internal';
import { sameRtdbValue } from '../rtdb-value-equality.js';
import { isDisconnectedPort } from './core.js';
import type { RtdbDataSnapshot, RtdbRefHandle } from './handles.js';
import { observeRtdbConnection } from './rtdb-connection-lifecycle.js';
import { makeRtdbSnapshot } from './rtdb-snapshots.js';
import type { RtdbTarget } from './rtdb-references.js';
import { targetParts } from './rtdb-references.js';

type RtdbQuerySpec = NonNullable<ReturnType<typeof targetParts>['query']>;

/** True when the client answers `ref` itself: a `.info` path on a live app port. */
export function servesInfoLocally(ref: RtdbRefHandle): boolean {
  return isInfoPath(ref.path) && !isDisconnectedPort(ref.port);
}

/** The value at a `.info` path for a connection state. */
function infoValue(path: string, connected: boolean): unknown {
  const segments = path.split('/').filter(segment => segment.length > 0).slice(1);
  let value: unknown = { connected, serverTimeOffset: 0 };
  for (const segment of segments) {
    const isBranch = value !== null && typeof value === 'object';
    value = isBranch ? (value as Record<string, unknown>)[segment] ?? null : null;
  }
  return value;
}

/** The snapshot a listener or read sees, with a query's selection applied to a branch. */
function infoSnapshot(ref: RtdbRefHandle, value: unknown, query: RtdbQuerySpec | undefined): { snapshot: RtdbDataSnapshot; content: unknown } {
  const filtersChildren = query !== undefined && value !== null && typeof value === 'object';
  if (!filtersChildren) return { snapshot: makeRtdbSnapshot(ref, value), content: value };
  const rows = executeQuery(value as Parameters<typeof executeQuery>[0], query);
  const hasRows = rows.length > 0;
  const projection = Object.fromEntries(rows.map(({ key, value: child }) => [key, child]));
  const selectedValue = hasRows ? projection : null;
  return { snapshot: makeRtdbSnapshot(ref, selectedValue, hasRows, null, rows), content: rows };
}

/**
 * Delivers the value at `target`'s `.info` path when it is registered, then
 * each time it changes. A value equal to the last one delivered is not
 * delivered again, so `serverTimeOffset` and other paths deliver once.
 */
export function observeInfo(target: RtdbTarget, next: (snapshot: RtdbDataSnapshot) => void): () => void {
  const { ref, query } = targetParts(target);
  let delivered = false;
  let previous: unknown;
  return observeRtdbConnection(ref, (connected) => {
    const { snapshot, content } = infoSnapshot(ref, infoValue(ref.path, connected), query);
    const isUnchanged = delivered && sameRtdbValue(previous, content);
    if (isUnchanged) return;
    delivered = true;
    previous = content;
    next(snapshot);
  });
}

/** A one-time read of `target`'s `.info` path, answered from the client's own state. */
export function readInfo(target: RtdbTarget): Promise<RtdbDataSnapshot> {
  return new Promise((resolve) => {
    let answered = false;
    const stop = observeInfo(target, (snapshot) => {
      if (answered) return;
      answered = true;
      resolve(snapshot);
      // A transport may report its state before `observeInfo` returns.
      queueMicrotask(() => stop());
    });
  });
}
