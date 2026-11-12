import { normalizeRuleWrite } from '../data/normalize.js';
import { resolveSentinels } from '../data/sentinels.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Set `key` on `target` as an own data property. Plain assignment would run
 * the `__proto__` setter instead, so a key named `__proto__` would never land
 * in the tree, where production stores it as an ordinary key (capture
 * rules-rtdb-r52-prototype-named-keys, CS-1).
 */
function defineChild(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function arrayToRecord(arr: readonly unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < arr.length; i++) {
    if (i in arr && arr[i] !== null && arr[i] !== undefined) {
      out[String(i)] = arr[i];
    }
  }
  return out;
}

/** The value stored at `path` in a root tree, or undefined. */
export function valueAtPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  const segments = path.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === '.priority' && i === segments.length - 1) {
      return isRecord(cursor) && Object.hasOwn(cursor, '.priority') ? cursor['.priority'] : undefined;
    }
    if (segment === '.priority' || segment === '.value') return undefined;
    while (isRecord(cursor) && Object.hasOwn(cursor, '.value')) {
      cursor = cursor['.value'];
    }
    if (Array.isArray(cursor)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length || String(idx) !== segment || !(idx in cursor)) {
        return undefined;
      }
      cursor = cursor[idx];
    } else if (isRecord(cursor)) {
      if (!Object.hasOwn(cursor, segment)) return undefined;
      cursor = cursor[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/**
 * Resolve server sentinels (`timestamp`, `increment`) and apply RTDB
 * write-boundary normalization (array → integer-keyed object, null/empty
 * pruning, and priority pruning on empty nodes) to a proposed write value.
 */
function resolveWriteValue(base: unknown, path: string, rawValue: unknown, now: number): unknown {
  if (rawValue === undefined) return null;
  const resolved = resolveSentinels(rawValue, now, valueAtPath(base, path));
  return normalizeRuleWrite(resolved);
}

/**
 * Stands in for an own `__proto__` key while an update value passes through
 * the sandbox's sentinel and normalization steps, which build objects by
 * assignment and would drop it. It holds U+0000, which no RTDB key can.
 */
const PROTO_STAND_IN = '\u0000__proto__';

/** `value` with every own key named `from` renamed to `to`, at any depth. */
function withKeyRenamed(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => withKeyRenamed(item, from, to));
  if (!isRecord(value)) return value;
  const renamed: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    defineChild(renamed, key === from ? to : key, withKeyRenamed(child, from, to));
  }
  return renamed;
}

/**
 * An update value as the database receives it. The SDK's `update()` sends
 * the caller's object as given (`repoUpdate` passes `childrenToMerge` to the
 * server), so an own `__proto__` key inside it is written and validated. A
 * `set()` value goes through `ChildrenNode.val()`, which assigns each child
 * and drops that key, so a single-path write does not keep it.
 */
function resolveUpdateValue(base: unknown, path: string, rawValue: unknown, now: number): unknown {
  const shielded = withKeyRenamed(rawValue, '__proto__', PROTO_STAND_IN);
  return withKeyRenamed(resolveWriteValue(base, path, shielded, now), PROTO_STAND_IN, '__proto__');
}

/**
 * Build the single post-write tree that a write/validate evaluation sees as
 * `newData`.
 *
 * For a single-path write this is `withValueAt(base, targetSegments,
 * resolvedNewData)`. For an atomic multi-path `update()` — where `updates`
 * lists every path written together — this folds `withValueAt` over EVERY
 * listed path so the projection reflects the ENTIRE update applied at once.
 */
export function projectPostWriteTree(
  base: unknown,
  path: string,
  targetSegments: string[],
  rawNewData: unknown,
  updates: readonly { path: string; value?: unknown }[] | undefined,
  evaluationNow: number,
): unknown {
  if (!updates || updates.length === 0) {
    return withValueAt(base, targetSegments, resolveWriteValue(base, path, rawNewData, evaluationNow));
  }
  const dataWrites: Array<{ segments: string[]; value: unknown }> = [];
  const dataDeletions: Array<{ segments: string[] }> = [];
  const priorityWrites: Array<{ segments: string[]; value: unknown }> = [];
  for (const update of updates) {
    const segments = update.path.split('/').filter(Boolean);
    const resolved = resolveUpdateValue(base, update.path, update.value, evaluationNow);
    if (segments[segments.length - 1] === '.priority') {
      priorityWrites.push({ segments, value: resolved });
    } else if (resolved === null || resolved === undefined) {
      dataDeletions.push({ segments });
    } else {
      dataWrites.push({ segments, value: resolved });
    }
  }
  let root = base;
  for (const { segments, value } of dataWrites) {
    root = withValueAt(root, segments, value);
  }
  for (const { segments } of dataDeletions) {
    root = withValueAt(root, segments, null);
  }
  for (const { segments, value } of priorityWrites) {
    root = withValueAt(root, segments, value);
  }
  return root;
}

/**
 * Return a new tree equal to `root` but with the value at `segments`
 * replaced by `value` (a `null`/`undefined` value deletes the node, same
 * as an RTDB write of `null`).
 *
 * Preserves RTDB node invariants across child writes and deletions:
 * - Writing a child under a `{ '.value': primitive, '.priority': p }` leaf
 *   promotes the node to an object and clears the primitive `.value` (`ENF-3a`).
 * - Deleting the last data child of an object auto-trims the empty ancestor
 *   along with any `.priority` metadata (`ENF-3c`).
 */
export function withValueAt(root: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) return value ?? null;

  const [head, ...rest] = segments;
  if (!head) return root ?? null;

  const isWrapper = isRecord(root) && Object.hasOwn(root, '.value');
  const rawUnwrapped = isWrapper ? root['.value'] : root;
  const unwrapped = Array.isArray(rawUnwrapped) ? arrayToRecord(rawUnwrapped) : rawUnwrapped;
  const isPlainObject = isRecord(unwrapped);

  if (head === '.priority' && rest.length === 0) {
    if (rawUnwrapped === null || rawUnwrapped === undefined) return null;
    if (isPlainObject) {
      const hasDataKey = Object.keys(unwrapped).some((key) => key !== '.priority');
      if (!hasDataKey) return null;
      const nextObj: Record<string, unknown> = { ...unwrapped };
      if (value === null || value === undefined) {
        delete nextObj['.priority'];
      } else {
        defineChild(nextObj, '.priority', value);
      }
      return nextObj;
    }
    if (value === null || value === undefined) {
      return rawUnwrapped;
    }
    return { '.value': rawUnwrapped, '.priority': value };
  }

  let existingChild: unknown = null;
  if (isPlainObject && Object.hasOwn(unwrapped, head)) {
    existingChild = unwrapped[head];
  }
  const childValue = withValueAt(existingChild, rest, value);

  if (childValue === null || childValue === undefined) {
    if (!isPlainObject) return root ?? null;
    const nextObj: Record<string, unknown> = { ...unwrapped };
    delete nextObj[head];
    const hasDataKey = Object.keys(nextObj).some((key) => key !== '.priority');
    if (!hasDataKey) return null;
    if (isWrapper && Object.hasOwn(root, '.priority')) {
      nextObj['.priority'] = root['.priority'];
    }
    return nextObj;
  }

  const nextObj: Record<string, unknown> = isPlainObject ? { ...unwrapped } : {};
  defineChild(nextObj, head, childValue);
  if (isWrapper && isPlainObject && Object.hasOwn(root, '.priority')) {
    nextObj['.priority'] = root['.priority'];
  }
  return nextObj;
}
