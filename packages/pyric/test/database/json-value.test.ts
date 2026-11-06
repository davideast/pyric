import { describe, expect, it } from 'bun:test';
import { isJsonObject, jsonValuesEqual } from '../../src/database/sandbox/data-tree.js';

describe('RTDB JSON value primitives', () => {
  it('compares object values without depending on key order', () => {
    expect(jsonValuesEqual(
      { room: { title: 'Launch', members: { alice: true, bob: true } } },
      { room: { members: { bob: true, alice: true }, title: 'Launch' } },
    )).toBe(true);
  });

  it('keeps array order significant', () => {
    expect(jsonValuesEqual(['alice', 'bob'], ['bob', 'alice'])).toBe(false);
  });

  it('compares -0 and 0 as the same JSON number', () => {
    expect(jsonValuesEqual(-0, 0)).toBe(true);
    expect(jsonValuesEqual({ score: -0 }, { score: 0 })).toBe(true);
  });

  it('reads an own __proto__ key as an ordinary key', () => {
    const withProtoKey = JSON.parse('{"__proto__":{}}') as unknown;
    expect(jsonValuesEqual(withProtoKey, { title: {} })).toBe(false);
    expect(jsonValuesEqual({ title: {} }, withProtoKey)).toBe(false);
  });

  it('recognizes RTDB JSON object nodes, not arrays or absent values', () => {
    expect(isJsonObject({ patch: true })).toBe(true);
    expect(isJsonObject(['patch'])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });
});
