import { describe, expect, it } from 'bun:test';
import {
  createAdminVector,
  encodeAdminVectorForWire,
  FirebaseFirestoreError,
  isAdminVectorValue,
  tryDecodeAdminVectorFromWire,
} from '../../src/firestore/admin-vector-and-errors.js';

describe('pyric-admin/firestore VectorValue and FirebaseFirestoreError', () => {
  it('roundtrips finite and non-finite vector arrays and compares equality', () => {
    const v1 = createAdminVector([0.25, -0.5, 1.5]);
    const v1Copy = createAdminVector([0.25, -0.5, 1.5]);
    const v2 = createAdminVector([0.25, -0.5, 2.0]);
    expect(isAdminVectorValue(v1)).toBe(true);
    expect(v1.toArray()).toEqual([0.25, -0.5, 1.5]);
    expect(v1.isEqual(v1Copy)).toBe(true);
    expect(v1.isEqual(v2)).toBe(false);
    expect(createAdminVector([]).toArray()).toEqual([]);

    const special = createAdminVector([1, Number.NaN, Number.POSITIVE_INFINITY]);
    const decoded = tryDecodeAdminVectorFromWire(encodeAdminVectorForWire(special));
    expect(decoded?.isEqual(special)).toBe(true);

    let threw = false;
    try {
      createAdminVector(['bad'] as unknown as number[]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('prefixes FirebaseFirestoreError code with firestore/ and serializes toJSON', () => {
    const err = new FirebaseFirestoreError({
      code: 'not-found',
      message: 'Sample missing document',
    });
    expect(err instanceof Error).toBe(true);
    expect(err.code).toBe('firestore/not-found');
    expect(err.message).toBe('Sample missing document');
    expect(err.toJSON()).toEqual({
      code: 'firestore/not-found',
      message: 'Sample missing document',
    });
  });
});
