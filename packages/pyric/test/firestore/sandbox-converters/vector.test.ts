/**
 * Item 5 — VectorValue converter + wire round-trip tests.
 *
 * Plan section Item 5 test contract:
 *   - Seed `{ embedding: new Vector([0.1, 0.2, 0.3]) }`. Discover
 *     reports `kind: 'vector', dimension: 3`.
 *   - Round-trip via the encoder/decoder produces the same value.
 *
 * Plus direct converter unit tests (KEEP / idempotency / duck-type
 * boundary) matching the reference.test.ts shape.
 */
import { describe, test, expect } from 'bun:test';
import { vectorValueConverter } from 'pyric/sandbox/internal';
import { Vector } from 'pyric/rules/internal';
import { KEEP } from 'pyric/sandbox/internal';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { encodeValue, encodeFieldsProto } from 'pyric/sandbox/internal';
import { wireValueToFieldType } from 'pyric-tools/discover';

const baseCtx = (
  overrides: Partial<{
    path: string;
    method: 'create' | 'update' | 'set' | 'seed';
    prior: Record<string, unknown> | null;
    fieldPath: string;
    serverTime: unknown;
  }> = {},
) => ({
  path: 'docs/x',
  method: 'create' as const,
  prior: null,
  fieldPath: 'embedding',
  ...overrides,
});

/** Build a duck-typed admin SDK VectorValue for converter tests. */
function fakeAdminVectorValue(values: number[]): unknown {
  return {
    _values: values.slice(),
    toArray() {
      return values.slice();
    },
  };
}

// ─── Converter unit tests ──────────────────────────────────────────────────

describe('vectorValueConverter', () => {
  test('wraps an admin-SDK VectorValue into our Vector', () => {
    const out = vectorValueConverter.convert(fakeAdminVectorValue([0.1, 0.2, 0.3]), baseCtx());
    expect(out).toBeInstanceOf(Vector);
    expect((out as Vector).value).toEqual([0.1, 0.2, 0.3]);
    expect((out as Vector).dimension).toBe(3);
  });

  test('idempotent: a Vector wrapper on a second pass declines', () => {
    const v = new Vector([1, 2, 3]);
    expect(vectorValueConverter.convert(v, baseCtx())).toBe(KEEP);
  });

  test('declines plain values', () => {
    expect(vectorValueConverter.convert([1, 2, 3], baseCtx())).toBe(KEEP);
    expect(vectorValueConverter.convert(42, baseCtx())).toBe(KEEP);
    expect(vectorValueConverter.convert(null, baseCtx())).toBe(KEEP);
    expect(vectorValueConverter.convert({ a: 1 }, baseCtx())).toBe(KEEP);
  });

  test('declines plain objects that lack the admin private members', () => {
    // Has _values but no toArray — not the real admin shape.
    expect(
      vectorValueConverter.convert({ _values: [1, 2] }, baseCtx()),
    ).toBe(KEEP);
    // Has toArray but _values is the wrong type.
    expect(
      vectorValueConverter.convert({ _values: 'oops', toArray: () => [] }, baseCtx()),
    ).toBe(KEEP);
  });

  test('declines if any _values element is non-numeric', () => {
    // Pathological seed: shape matches but elements are strings. Block
    // it so the wrapper invariant ("values are numbers") is upheld.
    expect(
      vectorValueConverter.convert(
        { _values: [1, 'two'], toArray: () => [1, 'two'] },
        baseCtx(),
      ),
    ).toBe(KEEP);
  });
});

// ─── Wire encoding ─────────────────────────────────────────────────────────

describe('wire-encoder — Vector', () => {
  test('encodes Vector as the __vector__ sentinel mapValue', () => {
    const out = encodeValue(new Vector([0.1, 0.2, 0.3]));
    expect(out).toEqual({
      mapValue: {
        fields: {
          __type__: { stringValue: '__vector__' },
          value: {
            arrayValue: {
              values: [
                { doubleValue: 0.1 },
                { doubleValue: 0.2 },
                { doubleValue: 0.3 },
              ],
            },
          },
        },
      },
    });
  });

  test('discover/wire.ts decodes the encoded Vector to kind:vector', () => {
    const wire = encodeValue(new Vector([0.1, 0.2, 0.3]));
    const ft = wireValueToFieldType(wire);
    expect(ft).toEqual({ kind: 'vector', dimension: 3 });
  });

  test('round-trips an empty vector with dimension 0', () => {
    const wire = encodeValue(new Vector([]));
    expect(wireValueToFieldType(wire)).toEqual({ kind: 'vector', dimension: 0 });
  });

  test('encodeFieldsProto produces the per-field sentinel shape', () => {
    const proto = encodeFieldsProto({ embedding: new Vector([1, 2]) });
    expect(proto.embedding).toEqual({
      mapValue: {
        fields: {
          __type__: { stringValue: '__vector__' },
          value: {
            arrayValue: {
              values: [{ doubleValue: 1 }, { doubleValue: 2 }],
            },
          },
        },
      },
    });
  });
});

// ─── LocalEnvironment seeding parity ─────────────────────────────────────

describe('LocalEnvironment — Vector seeding', () => {
  test('seeded Vector is preserved as a Vector instance (not walked as a plain map)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules:
        "rules_version = '2'; service cloud.firestore {" +
        '  match /databases/{database}/documents {' +
        '    match /{document=**} { allow read, write: if true; }' +
        '  }' +
        '}',
      documents: { 'docs/d1': { embedding: new Vector([0.1, 0.2, 0.3]) } },
    });
    const stored = env.getDocument('docs/d1');
    expect(stored?.['embedding']).toBeInstanceOf(Vector);
    expect((stored?.['embedding'] as Vector).dimension).toBe(3);
    expect((stored?.['embedding'] as Vector).value).toEqual([0.1, 0.2, 0.3]);
  });

  test('writing an admin-SDK VectorValue stores it as our Vector', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules:
        "rules_version = '2'; service cloud.firestore {" +
        '  match /databases/{database}/documents {' +
        '    match /{document=**} { allow read, write: if true; }' +
        '  }' +
        '}',
      documents: {},
    });
    const r = env.execute({
      method: 'create',
      path: 'docs/d1',
      auth: { uid: 'u1' },
      data: { embedding: fakeAdminVectorValue([1, 2, 3]) },
    });
    expect(r.allowed).toBe(true);
    const stored = env.getDocument('docs/d1');
    expect(stored?.['embedding']).toBeInstanceOf(Vector);
    expect((stored?.['embedding'] as Vector).value).toEqual([1, 2, 3]);
  });
});
