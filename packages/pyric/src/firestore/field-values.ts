/**
 * `pyric/firestore` -- field-value sentinels + sandbox scalar types.
 *
 * Canonical `firebase/firestore` imports still receive Firebase's classes
 * when package resolution has not selected Pyric. This mirror owns local
 * equivalents so its sandbox implementation never loads the production SDK.
 */
import {
  Timestamp as ChainTimestamp,
  type FieldValueSentinel,
} from 'pyric/sandbox/admin-firestore';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import {
  FieldValue,
  createArrayRemoveSentinel,
  createArrayUnionSentinel,
  createDeleteFieldSentinel,
  createIncrementSentinel,
  createMaximumSentinel,
  createMinimumSentinel,
  createServerTimestampSentinel,
} from './field-value-sentinels.js';
import { canonicalFieldPath } from './sandbox/update-fields.js';

export { Bytes } from './bytes.js';

export { GeoPoint } from './geo-point.js';

export class FieldPath {
  readonly _internalPath: { segments: string[]; offset: number; len: number };

  constructor(...fieldNames: string[]) {
    if (fieldNames.length === 0) {
      throw new FirebaseError(
        'invalid-argument',
        'Function FieldPath() cannot be called with no arguments.',
      );
    }
    for (let index = 0; index < fieldNames.length; index += 1) {
      const name = fieldNames[index];
      if (typeof name !== 'string' || name.length === 0) {
        throw new FirebaseError(
          'invalid-argument',
          `Invalid field name at argument ${index + 1}. Field names must not be empty.`,
        );
      }
    }
    this._internalPath = {
      segments: fieldNames.slice(),
      offset: 0,
      len: fieldNames.length,
    };
  }

  isEqual(other: FieldPath): boolean {
    const ours = this._internalPath.segments;
    const theirs = other?._internalPath?.segments;
    return Array.isArray(theirs)
      && ours.length === theirs.length
      && ours.every((segment, index) => segment === theirs[index]);
  }

  toString(): string {
    return canonicalFieldPath(this._internalPath.segments);
  }
}

export function documentId(): FieldPath {
  return new FieldPath('__name__');
}

export { VectorValue, vector } from './vector-value.js';

export { FieldValue, ChainTimestamp as Timestamp };

export function serverTimestamp(): FieldValue & FieldValueSentinel {
  return createServerTimestampSentinel();
}
export function increment(n: number): FieldValue & FieldValueSentinel {
  return createIncrementSentinel(n);
}
export function maximum(n: number): FieldValue & FieldValueSentinel {
  return createMaximumSentinel(n);
}
export function minimum(n: number): FieldValue & FieldValueSentinel {
  return createMinimumSentinel(n);
}
export function arrayUnion(...values: unknown[]): FieldValue & FieldValueSentinel {
  return createArrayUnionSentinel(values);
}
export function arrayRemove(...values: unknown[]): FieldValue & FieldValueSentinel {
  return createArrayRemoveSentinel(values);
}
export function deleteField(): FieldValue & FieldValueSentinel {
  return createDeleteFieldSentinel();
}
