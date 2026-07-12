/**
 * Unit tests for the wire-format → FieldObservation conversion.
 *
 * Covers the Phase 0.1 wire contract (every Firestore wire kind maps to
 * exactly one FieldType) plus the prerequisites added in Item 1.3:
 *   - 0.A: fail-loud when _fieldsProto is missing or malformed
 *   - 0.B: reserved field-name detection per the four classification
 *     patterns (firestore_reserved, dotted, numeric, double-underscore)
 */

import { describe, expect, test } from 'bun:test';
import {
  classifyFieldName,
  snapshotToObservations,
  wireValueToFieldType,
  wireValueToObservation,
  WireProtoUnavailableError,
} from '../../src/discover/wire.js';

// ─── Wire kind coverage ───────────────────────────────────────────────────

describe('wireValueToFieldType — all 12 wire kinds', () => {
  test('null', () => {
    expect(wireValueToFieldType({ nullValue: null })).toEqual({
      kind: 'scalar',
      type: 'null',
    });
  });
  test('boolean', () => {
    expect(wireValueToFieldType({ booleanValue: true })).toEqual({
      kind: 'scalar',
      type: 'boolean',
    });
  });
  test('integer', () => {
    expect(wireValueToFieldType({ integerValue: '42' })).toEqual({
      kind: 'scalar',
      type: 'integer',
    });
  });
  test('double', () => {
    expect(wireValueToFieldType({ doubleValue: 3.14 })).toEqual({
      kind: 'scalar',
      type: 'double',
    });
  });
  test('timestamp', () => {
    expect(
      wireValueToFieldType({ timestampValue: { seconds: '1', nanos: 0 } }),
    ).toEqual({ kind: 'scalar', type: 'timestamp' });
  });
  test('string', () => {
    expect(wireValueToFieldType({ stringValue: 'hi' })).toEqual({
      kind: 'scalar',
      type: 'string',
    });
  });
  test('bytes', () => {
    expect(wireValueToFieldType({ bytesValue: 'aGk=' })).toEqual({
      kind: 'scalar',
      type: 'bytes',
    });
  });
  test('geopoint', () => {
    expect(
      wireValueToFieldType({ geoPointValue: { latitude: 0, longitude: 0 } }),
    ).toEqual({ kind: 'scalar', type: 'geopoint' });
  });
  test('reference parses to template-form full path', () => {
    const ref = wireValueToFieldType({
      referenceValue:
        'projects/p/databases/(default)/documents/users/uid_1/posts/p_1',
    });
    expect(ref).toEqual({ kind: 'reference', targetCollection: 'users/uid_1/posts' });
  });
  test('array recursively types elements + dedups', () => {
    const arr = wireValueToFieldType({
      arrayValue: {
        values: [{ stringValue: 'a' }, { stringValue: 'b' }, { integerValue: '1' }],
      },
    });
    expect(arr.kind).toBe('array');
    if (arr.kind === 'array') {
      expect(arr.elementTypes).toHaveLength(2); // string + integer (string deduped)
    }
  });
  test('map types each field', () => {
    const m = wireValueToFieldType({
      mapValue: {
        fields: {
          name: { stringValue: 'a' },
          age: { integerValue: '30' },
        },
      },
    });
    expect(m.kind).toBe('map');
    if (m.kind === 'map') {
      expect(Object.keys(m.fields).sort()).toEqual(['age', 'name']);
    }
  });
  test('vector sentinel detected', () => {
    const v = wireValueToFieldType({
      mapValue: {
        fields: {
          __type__: { stringValue: '__vector__' },
          value: {
            arrayValue: {
              values: [{ doubleValue: 0.1 }, { doubleValue: 0.2 }, { doubleValue: 0.3 }],
            },
          },
        },
      },
    });
    expect(v).toEqual({ kind: 'vector', dimension: 3 });
  });
});

// ─── Reference path edge cases ────────────────────────────────────────────

describe('reference path parsing', () => {
  test('top-level ref returns single segment', () => {
    const ref = wireValueToFieldType({
      referenceValue: 'projects/p/databases/(default)/documents/users/u1',
    });
    expect(ref).toEqual({ kind: 'reference', targetCollection: 'users' });
  });
  test('deep-nested ref preserves full path', () => {
    const ref = wireValueToFieldType({
      referenceValue:
        'projects/p/databases/(default)/documents/orgs/o/teams/t/users/u',
    });
    expect(ref).toEqual({
      kind: 'reference',
      targetCollection: 'orgs/o/teams/t/users',
    });
  });
});

// ─── Observation extraction ───────────────────────────────────────────────

describe('wireValueToObservation', () => {
  test('string carries example + enumSample', () => {
    const obs = wireValueToObservation({ stringValue: 'open' });
    expect(obs.example).toBe('open');
    expect(obs.enumSample).toBe('open');
    expect(obs.isNull).toBe(false);
  });
  test('integer parses to number when safe', () => {
    const obs = wireValueToObservation({ integerValue: '42' });
    expect(obs.example).toBe(42);
    expect(obs.enumSample).toBe(42);
  });
  test('integer outside safe range falls back to string example, no enum', () => {
    const huge = String(Number.MAX_SAFE_INTEGER) + '0';
    const obs = wireValueToObservation({ integerValue: huge });
    expect(obs.example).toBe(huge);
    expect(obs.enumSample).toBeUndefined();
  });
  test('boolean: example yes, enumSample no', () => {
    const obs = wireValueToObservation({ booleanValue: true });
    expect(obs.example).toBe(true);
    expect(obs.enumSample).toBeUndefined();
  });
  test('null: isNull=true, example=null', () => {
    const obs = wireValueToObservation({ nullValue: null });
    expect(obs.isNull).toBe(true);
    expect(obs.example).toBe(null);
  });
  test('timestamp: type yes, no example', () => {
    const obs = wireValueToObservation({
      timestampValue: { seconds: '1', nanos: 0 },
    });
    expect(obs.type).toEqual({ kind: 'scalar', type: 'timestamp' });
    expect(obs.example).toBeUndefined();
  });
});

// ─── Reserved name classification (0.B) ───────────────────────────────────

describe('classifyFieldName (0.B)', () => {
  test('normal names pass through', () => {
    expect(classifyFieldName('name')).toBeUndefined();
    expect(classifyFieldName('user_id')).toBeUndefined();
    expect(classifyFieldName('createdAt')).toBeUndefined();
  });
  test('__name__ is firestore_reserved_name', () => {
    expect(classifyFieldName('__name__')).toBe('firestore_reserved_name');
  });
  test('dotted names flagged', () => {
    expect(classifyFieldName('user.name')).toBe('dotted_field_name');
    expect(classifyFieldName('a.b.c')).toBe('dotted_field_name');
  });
  test('numeric names flagged', () => {
    expect(classifyFieldName('0')).toBe('numeric_field_name');
    expect(classifyFieldName('42')).toBe('numeric_field_name');
    expect(classifyFieldName('-1')).toBe('numeric_field_name');
  });
  test('double-underscore-wrapped names flagged', () => {
    expect(classifyFieldName('__type__')).toBe('double_underscore_wrap');
    expect(classifyFieldName('__internal__')).toBe('double_underscore_wrap');
  });
  test('single underscore prefix is NOT flagged', () => {
    expect(classifyFieldName('_private')).toBeUndefined();
  });
});

// ─── Snapshot conversion (0.A + integration) ──────────────────────────────

describe('snapshotToObservations', () => {
  test('happy path: all fields converted', () => {
    const snap = {
      _fieldsProto: {
        name: { stringValue: 'alice' },
        age: { integerValue: '30' },
      },
      ref: { path: 'users/alice' },
    };
    const result = snapshotToObservations(snap);
    expect(Object.keys(result.observations).sort()).toEqual(['age', 'name']);
    expect(result.reservedNames).toEqual({});
  });

  test('reserved names surfaced separately', () => {
    const snap = {
      _fieldsProto: {
        name: { stringValue: 'alice' },
        '__name__': { stringValue: 'foo' },
        'user.id': { stringValue: 'bar' },
      },
      ref: { path: 'misc/d1' },
    };
    const result = snapshotToObservations(snap);
    expect(result.reservedNames).toEqual({
      '__name__': 'firestore_reserved_name',
      'user.id': 'dotted_field_name',
    });
    // Reserved names ALSO appear in observations — caller decides whether
    // to feed them through merge.
    expect(Object.keys(result.observations).sort()).toEqual(
      ['__name__', 'name', 'user.id'].sort(),
    );
  });

  test('0.A: missing _fieldsProto throws WireProtoUnavailableError', () => {
    const snap = { ref: { path: 'users/u1' } };
    expect(() => snapshotToObservations(snap)).toThrow(WireProtoUnavailableError);
    try {
      snapshotToObservations(snap);
    } catch (e) {
      expect(e).toBeInstanceOf(WireProtoUnavailableError);
      expect((e as Error).message).toContain('users/u1');
      expect((e as Error).message).toContain('_fieldsProto');
    }
  });

  test('0.A: malformed proto value throws', () => {
    const snap = {
      _fieldsProto: {
        weird: { unknownKey: 'value' },
      },
      ref: { path: 'misc/d1' },
    };
    expect(() => snapshotToObservations(snap)).toThrow(WireProtoUnavailableError);
  });

  test('empty proto returns empty observations without throwing', () => {
    const snap = { _fieldsProto: {}, ref: { path: 'misc/empty' } };
    const result = snapshotToObservations(snap);
    expect(result.observations).toEqual({});
    expect(result.reservedNames).toEqual({});
  });

  test('error message includes recovery hint', () => {
    try {
      snapshotToObservations({ ref: { path: 'p/d' } });
    } catch (e) {
      expect((e as Error).message).toContain('numberTypeStrategy');
    }
  });
});
