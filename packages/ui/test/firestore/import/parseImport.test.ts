import { describe, expect, test } from 'bun:test';
import { detectCollisions, firestoreAutoId, parseImport } from '../../../src/firestore/import/parseImport.js';

describe('parseImport: map shape', () => {
  test('parses a docId -> fields map', () => {
    const { docs, errors } = parseImport('{"alice": {"name": "Alice"}, "bob": {"name": "Bob"}}');
    expect(errors).toEqual([]);
    expect(docs).toHaveLength(2);
    expect(docs).toContainEqual({ id: 'alice', data: { name: 'Alice' } });
    expect(docs).toContainEqual({ id: 'bob', data: { name: 'Bob' } });
  });

  test('flags an invalid document id but keeps the rest', () => {
    const { docs, errors } = parseImport('{"a/b": {"x": 1}, "ok": {"y": 2}}');
    expect(docs).toEqual([{ id: 'ok', data: { y: 2 } }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('a/b');
  });

  test('flags a non-object value', () => {
    const { docs, errors } = parseImport('{"alice": "not an object"}');
    expect(docs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('alice');
  });
});

describe('parseImport: array shape', () => {
  test('parses an array of plain objects as auto-id docs', () => {
    const { docs, errors } = parseImport('[{"name": "Alice"}, {"name": "Bob"}]');
    expect(errors).toEqual([]);
    expect(docs).toEqual([
      { id: null, data: { name: 'Alice' } },
      { id: null, data: { name: 'Bob' } },
    ]);
  });

  test('flags a non-object array element but keeps the rest', () => {
    const { docs, errors } = parseImport('[{"name": "Alice"}, "bogus", 42]');
    expect(docs).toEqual([{ id: null, data: { name: 'Alice' } }]);
    expect(errors).toHaveLength(2);
  });

  test('empty array parses to zero docs, no errors', () => {
    expect(parseImport('[]')).toEqual({ docs: [], errors: [] });
  });
});

describe('parseImport: invalid input', () => {
  test('empty string', () => {
    const { docs, errors } = parseImport('   ');
    expect(docs).toEqual([]);
    expect(errors).toEqual(['Input is empty']);
  });

  test('invalid JSON', () => {
    const { docs, errors } = parseImport('{not json');
    expect(docs).toEqual([]);
    expect(errors[0]).toContain('Invalid JSON');
  });

  test('a bare scalar or array-of-arrays top level is rejected', () => {
    expect(parseImport('42').errors[0]).toContain('must be a JSON object');
    expect(parseImport('null').errors[0]).toContain('must be a JSON object');
    expect(parseImport('"a string"').errors[0]).toContain('must be a JSON object');
  });
});

describe('detectCollisions', () => {
  test('finds map-shape ids that already exist', () => {
    const { docs } = parseImport('{"alice": {}, "carol": {}}');
    expect(detectCollisions(['alice', 'bob'], docs)).toEqual(['alice']);
  });

  test('no collisions when nothing overlaps', () => {
    const { docs } = parseImport('{"dave": {}}');
    expect(detectCollisions(['alice', 'bob'], docs)).toEqual([]);
  });

  test('array-shape (auto-id) docs never collide', () => {
    const { docs } = parseImport('[{"a": 1}, {"b": 2}]');
    expect(detectCollisions(['alice'], docs)).toEqual([]);
  });
});

describe('parseImport: generateId option (retry-idempotent auto ids)', () => {
  test('array-shape entries get ids from the generator instead of null', () => {
    let n = 0;
    const r = parseImport('[{"a":1},{"b":2}]', { generateId: () => `gen-${++n}` });
    expect(r.docs.map((d) => d.id)).toEqual(['gen-1', 'gen-2']);
  });

  test('map-shape ids are untouched by the generator', () => {
    const r = parseImport('{"alice":{"a":1}}', { generateId: () => 'gen' });
    expect(r.docs).toEqual([{ id: 'alice', data: { a: 1 } }]);
  });

  test('firestoreAutoId: 20 chars from the Firestore alphabet, non-colliding in practice', () => {
    const ids = new Set(Array.from({ length: 200 }, () => firestoreAutoId()));
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(ids.size).toBe(200);
  });
});
