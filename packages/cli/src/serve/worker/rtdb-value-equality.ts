/** Browser-safe structural equality for values crossing the RTDB worker wire. */
export function sameRtdbValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    // A hole and a `null` are the same RTDB value: the hosted transport's JSON
    // writes a sparse array's holes as `null` (RT-6, #1371).
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && Array.from(left, (value, index) => sameRtdbValue(value ?? null, right[index] ?? null)).every(Boolean);
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key, index) => key === rightKeys[index] && sameRtdbValue(leftRecord[key], rightRecord[key]),
  );
}
