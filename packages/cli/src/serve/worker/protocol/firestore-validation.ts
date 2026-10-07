import { FirebaseError } from 'pyric/app';

/** Refuse wire path coercion; the SDK still owns path-segment validation. */
export function requireFirestorePath(value: unknown): string {
  const isStringPath = typeof value === 'string';
  if (isStringPath) return value;
  throw new FirebaseError('invalid-argument', 'Firestore wire paths must be strings.');
}

/** Check the list container without claiming that its entries are valid. */
export function assertAtomicList(value: unknown, kind: 'read' | 'write'): asserts value is unknown[] {
  const isList = Array.isArray(value);
  if (isList) return;
  throw new FirebaseError('invalid-argument', `Firestore atomic ${kind} lists must be arrays.`);
}

/** Check an update field list: each entry names a non-empty segment vector of non-empty strings. */
export function requireUpdateFields(value: unknown): asserts value is { path: string[]; value: unknown }[] {
  const isFieldList = Array.isArray(value) && value.every((field: unknown) => {
    const isRecord = field !== null && typeof field === 'object' && !Array.isArray(field);
    if (!isRecord) return false;
    const path = (field as { path?: unknown }).path;
    return Array.isArray(path) && path.length > 0 && path.every((segment) => typeof segment === 'string' && segment.length > 0);
  });
  if (isFieldList) return;
  throw new FirebaseError('invalid-argument', 'Firestore update fields must name non-empty segment vectors.');
}
