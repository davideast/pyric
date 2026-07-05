import { describe, it, expect } from 'bun:test';
import { Timestamp, GeoPoint, Bytes } from 'pyric/firestore';
import { inferType, asVectorView } from '../../../src/firestore/types.js';

describe('inferType', () => {
  it('classifies strings', () => {
    expect(inferType('hello')).toBe('string');
    expect(inferType('')).toBe('string');
  });

  it('classifies numbers', () => {
    expect(inferType(0)).toBe('number');
    expect(inferType(-1)).toBe('number');
    expect(inferType(3.14)).toBe('number');
    expect(inferType(Number.NaN)).toBe('number');
    expect(inferType(Infinity)).toBe('number');
  });

  it('classifies booleans', () => {
    expect(inferType(true)).toBe('boolean');
    expect(inferType(false)).toBe('boolean');
  });

  it('classifies null and coerces undefined to null', () => {
    expect(inferType(null)).toBe('null');
    expect(inferType(undefined)).toBe('null');
  });

  it('classifies arrays', () => {
    expect(inferType([])).toBe('array');
    expect(inferType([1, 2, 3])).toBe('array');
    expect(inferType(['a', 'b'])).toBe('array');
  });

  it('classifies plain objects as map', () => {
    expect(inferType({})).toBe('map');
    expect(inferType({ a: 1 })).toBe('map');
    expect(inferType({ nested: { deep: true } })).toBe('map');
  });

  it('classifies a serialized Timestamp shape as timestamp (worker boundary strips the class)', () => {
    expect(inferType({ seconds: 1781825935, nanoseconds: 502000000 })).toBe('timestamp');
    expect(inferType({ _seconds: 1781825935, _nanoseconds: 0 })).toBe('timestamp');
    // a genuine map that merely contains those keys (+ a third) stays a map
    expect(inferType({ seconds: 1, nanoseconds: 2, label: 'x' })).toBe('map');
    expect(inferType({ seconds: 1 })).toBe('map');
  });

  it('classifies a serialized GeoPoint shape as geopoint', () => {
    expect(inferType({ latitude: 37.7749, longitude: -122.4194 })).toBe('geopoint');
    // a map with extra keys stays a map
    expect(inferType({ latitude: 1, longitude: 2, label: 'x' })).toBe('map');
  });

  it('classifies Timestamp', () => {
    const ts = Timestamp.fromDate(new Date('2025-01-01T00:00:00Z'));
    expect(inferType(ts)).toBe('timestamp');
  });

  it('classifies GeoPoint', () => {
    expect(inferType(new GeoPoint(0, 0))).toBe('geopoint');
    expect(inferType(new GeoPoint(37.7749, -122.4194))).toBe('geopoint');
  });

  it('classifies Bytes', () => {
    expect(inferType(Bytes.fromBase64String('aGVsbG8='))).toBe('bytes');
  });

  it('classifies DocumentReference-shaped objects', () => {
    const refLike = {
      path: 'users/alice',
      id: 'alice',
      firestore: { _isFirestore: true },
      type: 'document',
    };
    expect(inferType(refLike)).toBe('reference');
  });

  it('does NOT classify maps that lack the firestore brand as references', () => {
    // A user document with fields named `path` and `id` should
    // remain a `map` — without a `firestore` object handle it's
    // not reference-shaped.
    expect(inferType({ path: 'foo', id: 'bar' })).toBe('map');
  });

  it('classifies Date objects as map (not timestamp)', () => {
    // Firestore stores Date inputs by converting to Timestamp at
    // write time, but a raw JS Date on the read side would be
    // unusual. We classify by what's present in the snapshot,
    // which means a Date instance is a generic object → map.
    // The test pins this so a future change is deliberate.
    expect(inferType(new Date())).toBe('map');
  });

  describe('vector', () => {
    const dims = (n: number) => Array.from({ length: n }, (_, i) => i / 1000);

    it('classifies a wire-sentinel vector as vector (not map)', () => {
      const v = { __type__: '__vector__', value: dims(768) };
      expect(inferType(v)).toBe('vector');
    });

    it('classifies a pyric Vector-wrapper shape as vector', () => {
      // The pyric `Vector` class brands itself with typeName + a frozen
      // numeric `.value` array. We match structurally — no import of the
      // class, which `pyric/firestore` doesn't re-export.
      const v = { typeName: 'vector', value: dims(3), dimension: 3 };
      expect(inferType(v)).toBe('vector');
    });

    it('classifies an admin-VectorValue shape (_values) as vector', () => {
      const v = { _values: dims(4), toArray: () => dims(4) };
      expect(inferType(v)).toBe('vector');
    });

    it('classifies a web-VectorValue shape (toArray only) as vector', () => {
      const arr = dims(5);
      const v = { toArray: () => arr };
      expect(inferType(v)).toBe('vector');
    });

    it('does NOT classify a bare number[] as vector (stays array)', () => {
      expect(inferType([0.1, 0.2, 0.3])).toBe('array');
      expect(inferType([])).toBe('array');
    });

    it('does NOT classify a plain map as vector', () => {
      expect(inferType({ value: 'not an array' })).toBe('map');
      expect(inferType({ __type__: 'other', value: [1, 2] })).toBe('map');
    });
  });
});

describe('asVectorView', () => {
  it('returns null for non-vector values', () => {
    expect(asVectorView(null)).toBeNull();
    expect(asVectorView(42)).toBeNull();
    expect(asVectorView([1, 2, 3])).toBeNull();
    expect(asVectorView({ a: 1 })).toBeNull();
  });

  it('extracts values + dimension from the wire-sentinel shape', () => {
    const view = asVectorView({ __type__: '__vector__', value: [0.1, 0.2, 0.3] });
    expect(view).not.toBeNull();
    expect(view!.values).toEqual([0.1, 0.2, 0.3]);
    expect(view!.dimension).toBe(3);
  });

  it('extracts from the pyric Vector-wrapper shape', () => {
    const view = asVectorView({ typeName: 'vector', value: [1, 2], dimension: 2 });
    expect(view!.values).toEqual([1, 2]);
    expect(view!.dimension).toBe(2);
  });

  it('extracts from an admin VectorValue (_values)', () => {
    const view = asVectorView({ _values: [9, 8, 7], toArray: () => [9, 8, 7] });
    expect(view!.values).toEqual([9, 8, 7]);
    expect(view!.dimension).toBe(3);
  });

  it('extracts from a web VectorValue (toArray)', () => {
    const view = asVectorView({ toArray: () => [4, 5] });
    expect(view!.values).toEqual([4, 5]);
    expect(view!.dimension).toBe(2);
  });

  it('returns a defensive copy (mutating the result does not affect source)', () => {
    const source = { __type__: '__vector__', value: [1, 2, 3] };
    const view = asVectorView(source)!;
    view.values.push(99);
    expect(source.value).toEqual([1, 2, 3]);
  });

  it('rejects a toArray that returns non-numeric data', () => {
    expect(asVectorView({ toArray: () => ['a', 'b'] })).toBeNull();
  });
});
