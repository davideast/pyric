interface FirestoreValueComparable {
  isEqual(other: unknown): boolean;
}

function hasFirestoreValueEquality(value: unknown): value is FirestoreValueComparable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isEqual' in value &&
    typeof (value as { isEqual?: unknown }).isEqual === 'function'
  );
}

function isFirestoreMapValue(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function firestoreValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (hasFirestoreValueEquality(a)) return a.isEqual(b);
  if (hasFirestoreValueEquality(b)) return b.isEqual(a);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => firestoreValuesEqual(value, b[index]));
  }
  if (!isFirestoreMapValue(a) || !isFirestoreMapValue(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in b && firestoreValuesEqual(a[key], b[key]));
}
