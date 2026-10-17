import { normalizeRuleWrite } from '../../../database/sandbox/normalize.js';
import { resolveSentinels } from '../../../database/sandbox/sentinels.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The value stored at `path` in a root tree, or undefined. */
export function valueAtPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split('/').filter(Boolean)) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
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
  let root = base;
  for (const update of updates) {
    const segments = update.path.split('/').filter(Boolean);
    root = withValueAt(root, segments, resolveWriteValue(base, update.path, update.value, evaluationNow));
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
  const unwrapped = isWrapper ? root['.value'] : root;
  const isPlainObject = isRecord(unwrapped);

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
  nextObj[head] = childValue;
  if (isWrapper && isPlainObject && Object.hasOwn(root, '.priority')) {
    nextObj['.priority'] = root['.priority'];
  }
  return nextObj;
}
