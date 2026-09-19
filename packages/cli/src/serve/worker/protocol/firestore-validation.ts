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
