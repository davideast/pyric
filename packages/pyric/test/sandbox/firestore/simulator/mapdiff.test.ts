import { describe, test, expect } from 'bun:test';
import { MapDiff, FirestoreSet } from 'pyric/rules/internal';

describe('FirestoreSet', () => {
  test('hasOnly — all items in list', () => {
    const set = new FirestoreSet(['a', 'b']);
    expect(set.hasOnly(['a', 'b', 'c'])).toBe(true);
  });

  test('hasOnly — item not in list', () => {
    const set = new FirestoreSet(['a', 'b', 'd']);
    expect(set.hasOnly(['a', 'b', 'c'])).toBe(false);
  });

  test('hasOnly — empty set always true', () => {
    const set = new FirestoreSet([]);
    expect(set.hasOnly(['a', 'b'])).toBe(true);
  });

  test('hasAll — all keys present', () => {
    const set = new FirestoreSet(['a', 'b', 'c']);
    expect(set.hasAll(['a', 'b'])).toBe(true);
  });

  test('hasAll — missing key', () => {
    const set = new FirestoreSet(['a']);
    expect(set.hasAll(['a', 'b'])).toBe(false);
  });

  test('hasAny — one key present', () => {
    const set = new FirestoreSet(['a', 'c']);
    expect(set.hasAny(['b', 'c'])).toBe(true);
  });

  test('hasAny — no keys present', () => {
    const set = new FirestoreSet(['a']);
    expect(set.hasAny(['b', 'c'])).toBe(false);
  });

  test('size', () => {
    expect(new FirestoreSet(['a', 'b', 'c']).size()).toBe(3);
    expect(new FirestoreSet([]).size()).toBe(0);
  });

  test('preserves numeric values for membership', () => {
    const set = new FirestoreSet([1, 2]);
    expect(set.hasAll([1])).toBe(true);
    expect(set.hasAny([2])).toBe(true);
    expect(set.hasOnly([1, 2, 3])).toBe(true);
  });

  test('keeps numeric and string values distinct', () => {
    const set = new FirestoreSet([1, '1', 1]);
    expect(set.size()).toBe(2);
    expect(set.hasOnly([1])).toBe(false);
  });
});

describe('MapDiff', () => {
  describe('addedKeys', () => {
    test('new key in after', () => {
      const diff = new MapDiff({ a: 1 }, { a: 1, b: 2 });
      expect(diff.addedKeys().toArray()).toEqual(['b']);
    });

    test('no additions', () => {
      const diff = new MapDiff({ a: 1 }, { a: 2 });
      expect(diff.addedKeys().size()).toBe(0);
    });
  });

  describe('removedKeys', () => {
    test('key in before but not after', () => {
      const diff = new MapDiff({ a: 1, b: 2 }, { a: 1 });
      expect(diff.removedKeys().toArray()).toEqual(['b']);
    });

    test('no removals', () => {
      const diff = new MapDiff({ a: 1 }, { a: 1, b: 2 });
      expect(diff.removedKeys().size()).toBe(0);
    });
  });

  describe('changedKeys', () => {
    test('value changed', () => {
      const diff = new MapDiff({ a: 1, b: 'old' }, { a: 1, b: 'new' });
      expect(diff.changedKeys().toArray()).toEqual(['b']);
    });

    test('no changes', () => {
      const diff = new MapDiff({ a: 1 }, { a: 1 });
      expect(diff.changedKeys().size()).toBe(0);
    });

    test('nested object changed', () => {
      const diff = new MapDiff(
        { a: { x: 1 } },
        { a: { x: 2 } },
      );
      expect(diff.changedKeys().toArray()).toEqual(['a']);
    });

    test('nested object unchanged', () => {
      const diff = new MapDiff(
        { a: { x: 1, y: 2 } },
        { a: { x: 1, y: 2 } },
      );
      expect(diff.changedKeys().size()).toBe(0);
    });

    test('nested object unchanged regardless of key order', () => {
      const diff = new MapDiff(
        { a: { x: 1, y: 2 } },
        { a: { y: 2, x: 1 } },
      );
      expect(diff.changedKeys().size()).toBe(0);
    });
  });

  describe('affectedKeys', () => {
    test('combination of added, removed, changed', () => {
      const diff = new MapDiff(
        { a: 1, b: 'old', c: 3 },
        { a: 1, b: 'new', d: 4 },
      );
      const affected = diff.affectedKeys();
      expect(affected.hasAll(['b', 'c', 'd'])).toBe(true); // changed, removed, added
      expect(affected.hasAny(['a'])).toBe(false); // unchanged
      expect(affected.size()).toBe(3);
    });

    test('no changes — empty', () => {
      const diff = new MapDiff({ a: 1, b: 2 }, { a: 1, b: 2 });
      expect(diff.affectedKeys().size()).toBe(0);
    });
  });

  describe('unchangedKeys', () => {
    test('keys with same value', () => {
      const diff = new MapDiff(
        { a: 1, b: 'old', c: 3 },
        { a: 1, b: 'new', d: 4 },
      );
      expect(diff.unchangedKeys().toArray()).toEqual(['a']);
    });
  });

  describe('real-world: chess moveIntegrity pattern', () => {
    test('affectedKeys().hasOnly() for a chess move', () => {
      // Both before and after have ALL keys (flat document layout)
      const base = {
        a1: 'R', b1: 'N', c1: '', c3: '', d1: '', e1: 'K',
        moveFrom: '', moveTo: '', currentTurn: 'host', moveCount: 0,
        movedPiece: '', capturedPiece: '', moveType: '',
        hp_N1: 'b1', status: 'playing',
      };
      const after = {
        ...base,
        b1: '', c3: 'N', // knight moved from b1 to c3
        moveFrom: 'b1', moveTo: 'c3', currentTurn: 'guest', moveCount: 1,
        movedPiece: 'hp_N1', moveType: 'normal',
        hp_N1: 'c3',
      };
      const diff = new MapDiff(base, after);
      const affected = diff.affectedKeys();

      // The move should only affect: b1, c3, moveFrom, moveTo, currentTurn, moveCount, movedPiece, moveType, hp_N1
      expect(affected.hasOnly([
        'b1', 'c3', 'moveFrom', 'moveTo', 'currentTurn', 'moveCount',
        'movedPiece', 'moveType', 'hp_N1',
      ])).toBe(true);

      // status unchanged
      expect(affected.hasAny(['status'])).toBe(false);
      // a1, e1 unchanged
      expect(affected.hasAny(['a1', 'e1'])).toBe(false);
    });

    test('affectedKeys().hasOnly() with dynamic fields', () => {
      // Simulates: hasOnly(['moveFrom', 'moveTo', 'currentTurn', moveFrom, moveTo])
      const before = { a1: 'R', b1: 'N', moveFrom: '', moveTo: '', currentTurn: 'host' };
      const after = { a1: 'R', b1: '', c3: 'N', moveFrom: 'b1', moveTo: 'c3', currentTurn: 'guest' };
      const diff = new MapDiff(before, after);

      // The dynamic fields are the VALUES of moveFrom and moveTo in the after state
      const moveFrom = after.moveFrom; // 'b1'
      const moveTo = after.moveTo;     // 'c3'
      const allowedFields = ['moveFrom', 'moveTo', 'currentTurn', moveFrom, moveTo];

      expect(diff.affectedKeys().hasOnly(allowedFields)).toBe(true);
    });
  });

  describe('rules value equality edge cases', () => {
    test('null values', () => {
      const diff = new MapDiff({ a: null }, { a: null });
      expect(diff.changedKeys().size()).toBe(0);
    });

    test('null vs undefined treated as different', () => {
      const diff = new MapDiff({ a: null }, { a: undefined });
      expect(diff.changedKeys().size()).toBe(1);
    });

    test('number vs string', () => {
      const diff = new MapDiff({ a: 1 }, { a: '1' });
      expect(diff.changedKeys().size()).toBe(1);
    });

    test('empty arrays equal', () => {
      const diff = new MapDiff({ a: [] }, { a: [] });
      expect(diff.changedKeys().size()).toBe(0);
    });

    test('arrays with different order', () => {
      const diff = new MapDiff({ a: [1, 2] }, { a: [2, 1] });
      expect(diff.changedKeys().size()).toBe(1);
    });

    test('boolean values', () => {
      const diff = new MapDiff({ a: false }, { a: false });
      expect(diff.changedKeys().size()).toBe(0);
    });

    test('boolean changed', () => {
      const diff = new MapDiff({ a: false }, { a: true });
      expect(diff.changedKeys().size()).toBe(1);
    });
  });
});
