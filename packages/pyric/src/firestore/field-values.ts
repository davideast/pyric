/**
 * `pyric/firestore` — field-value sentinels + sandbox scalar types.
 *
 * Canonical `firebase/firestore` imports still receive Firebase's classes
 * when package resolution has not selected Pyric. This mirror owns local
 * equivalents so its sandbox implementation never loads the production SDK.
 */
import {
  FieldValue as ChainFieldValue,
  Timestamp as ChainTimestamp,
  type FieldValueSentinel,
} from 'pyric/sandbox/admin-firestore';

export { Bytes } from './bytes.js';

export { GeoPoint } from './geo-point.js';

export class FieldPath {
  readonly _internalPath: { segments: string[]; offset: number; len: number };

  constructor(...fieldNames: string[]) {
    if (fieldNames.length === 0 || fieldNames.some((name) => name.length === 0)) {
      throw new TypeError('FieldPath requires at least one non-empty field name.');
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
}

export function documentId(): FieldPath {
  return new FieldPath('__name__');
}

export { VectorValue, vector } from './vector-value.js';

export { ChainFieldValue as FieldValue, ChainTimestamp as Timestamp };

export function serverTimestamp(): FieldValueSentinel {
  return ChainFieldValue.serverTimestamp();
}
export function increment(n: number): FieldValueSentinel {
  return ChainFieldValue.increment(n);
}
export function arrayUnion(...values: unknown[]): FieldValueSentinel {
  return ChainFieldValue.arrayUnion(...values);
}
export function arrayRemove(...values: unknown[]): FieldValueSentinel {
  return ChainFieldValue.arrayRemove(...values);
}
export function deleteField(): FieldValueSentinel {
  return ChainFieldValue.delete();
}
