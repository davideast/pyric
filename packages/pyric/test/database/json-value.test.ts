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

  it('recognizes RTDB JSON object nodes, not arrays or absent values', () => {
    expect(isJsonObject({ patch: true })).toBe(true);
    expect(isJsonObject(['patch'])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });
});
