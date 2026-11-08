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

/** An update payload carries `data` or `fields`, never both. */
export function requireSingleUpdateForm(payload: { data?: unknown; fields?: unknown }): void {
  const hasBothForms = payload.data !== undefined && payload.fields !== undefined;
  if (!hasBothForms) return;
  throw new FirebaseError('invalid-argument', 'A Firestore update carries either data or fields, not both.');
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

/** Check optional `SetOptions` (`merge` boolean and/or `mergeFields` string array). */
export function assertSetOptions(value: unknown): void {
  if (value === undefined) return;
  const isRecord = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord) {
    throw new FirebaseError('invalid-argument', 'Invalid sandbox operation field: options.');
  }
  const { merge, mergeFields } = value as { merge?: unknown; mergeFields?: unknown };
  if (merge !== undefined && typeof merge !== 'boolean') {
    throw new FirebaseError('invalid-argument', 'Invalid sandbox operation field: options.merge.');
  }
  if (mergeFields !== undefined) {
    const isFieldList = Array.isArray(mergeFields) && mergeFields.every((field) => typeof field === 'string');
    if (!isFieldList) {
      throw new FirebaseError('invalid-argument', 'Invalid sandbox operation field: options.mergeFields.');
    }
  }
}

/** Check optional `aggregate.path` (`undefined` on `count`; optional non-empty `string[]` on `sum`/`average`). */
export function assertAggregateFieldPath(path: unknown, isCount: boolean): void {
  if (path === undefined) return;
  const isValidPath = !isCount
    && Array.isArray(path)
    && path.length > 0
    && path.every((segment) => typeof segment === 'string' && segment.length > 0);
  if (isValidPath) return;
  throw new FirebaseError('invalid-argument', 'Invalid sandbox operation field: aggregate.path.');
}
