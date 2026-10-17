function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
