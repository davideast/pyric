import { describe, it, expect } from 'bun:test';
import { Timestamp, GeoPoint, Bytes } from 'pyric/firestore';
import { validateLeaf, validateTree } from '../../../src/firestore/reducers/validation.js';
import { treeFromData } from '../../../src/firestore/reducers/tree.js';

describe('validateLeaf', () => {
  it('passes valid primitives', () => {
    expect(validateLeaf('string', 'a')).toBeUndefined();
    expect(validateLeaf('number', 1)).toBeUndefined();
    expect(validateLeaf('boolean', true)).toBeUndefined();
    expect(validateLeaf('null', null)).toBeUndefined();
  });

  it('rejects wrong primitive types', () => {
    expect(validateLeaf('string', 1)).toBeDefined();
    expect(validateLeaf('number', 'x')).toBeDefined();
    expect(validateLeaf('boolean', 1)).toBeDefined();
  });

  it('rejects non-finite numbers', () => {
    expect(validateLeaf('number', Number.NaN)).toBeDefined();
    expect(validateLeaf('number', Infinity)).toBeDefined();
  });

  it('passes a Timestamp', () => {
    expect(validateLeaf('timestamp', Timestamp.now())).toBeUndefined();
  });

  it('rejects a non-Timestamp', () => {
    expect(validateLeaf('timestamp', new Date())).toBeDefined();
  });

  it('validates GeoPoint range', () => {
    expect(validateLeaf('geopoint', new GeoPoint(0, 0))).toBeUndefined();
    // Constructor itself enforces range so we test only the
    // wrong-type rejection here.
    expect(validateLeaf('geopoint', { latitude: 0, longitude: 0 })).toBeDefined();
  });

  it('validates Bytes', () => {
    expect(validateLeaf('bytes', Bytes.fromBase64String(''))).toBeUndefined();
    expect(validateLeaf('bytes', 'aGVsbG8=')).toBeDefined();
  });

  it('validates reference paths', () => {
    const ok = {
      path: 'users/alice',
      id: 'alice',
      firestore: {},
      type: 'document',
    };
    expect(validateLeaf('reference', ok)).toBeUndefined();

    const empty = { path: '', id: '', firestore: {}, type: 'document' };
    expect(validateLeaf('reference', empty)).toBeDefined();

    const odd = { path: 'users', id: 'users', firestore: {}, type: 'document' };
    expect(validateLeaf('reference', odd)).toBeDefined(); // odd segment count
  });
});

describe('validateTree', () => {
  it('returns zero errors for a clean document', () => {
    const tree = treeFromData({ name: 'Alice', score: 42 });
    const { errorCount } = validateTree(tree);
    expect(errorCount).toBe(0);
  });

  it('flags an empty map-child key', () => {
    const tree = treeFromData({ a: 1 });
    // Hack the tree: blank the only child's key
    const rootChildren = tree.childIds[tree.rootId];
    const id = rootChildren[0];
    tree.nodes[id] = { ...tree.nodes[id], key: '' };
    const { errorCount, tree: validated } = validateTree(tree);
    expect(errorCount).toBe(1);
    expect(validated.nodes[id].error).toMatch(/required/i);
  });

  it('flags duplicate sibling keys', () => {
    const tree = treeFromData({ a: 1 });
    const rootId = tree.rootId;
    const a = tree.childIds[rootId][0];
    // Inject a second child with the same key.
    const dup = 'dup-id';
    tree.nodes[dup] = {
      id: dup,
      parentId: rootId,
      key: 'a',
      type: 'number',
      value: 2,
    };
    tree.childIds[dup] = [];
    tree.childIds[rootId] = [...tree.childIds[rootId], dup];
    const { errorCount } = validateTree(tree);
    // Both `a`s are flagged.
    expect(errorCount).toBeGreaterThanOrEqual(2);
  });
});
