interface FirestoreComparable {
  isEqual(other: unknown): boolean;
}

function hasFirestoreEquality(value: unknown): value is FirestoreComparable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isEqual' in value &&
    typeof (value as { isEqual?: unknown }).isEqual === 'function'
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Firestore-aware structural equality for values delivered by either the
 * in-process SDK or the SharedWorker serializer. */
export function firestoreValuesEqual(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (hasFirestoreEquality(previous)) return previous.isEqual(next);
  if (hasFirestoreEquality(next)) return next.isEqual(previous);
  if (previous instanceof Uint8Array || next instanceof Uint8Array) {
    if (!(previous instanceof Uint8Array) || !(next instanceof Uint8Array)) return false;
    if (previous.length !== next.length) return false;
    return previous.every((byte, index) => byte === next[index]);
  }
  if (Array.isArray(previous) || Array.isArray(next)) {
    if (!Array.isArray(previous) || !Array.isArray(next)) return false;
    if (previous.length !== next.length) return false;
    return previous.every((value, index) => firestoreValuesEqual(value, next[index]));
  }
  if (!isPlainRecord(previous) || !isPlainRecord(next)) return false;
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every(
    (key) => key in next && firestoreValuesEqual(previous[key], next[key]),
  );
}
