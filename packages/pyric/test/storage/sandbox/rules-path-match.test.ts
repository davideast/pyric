import { describe, expect, test } from 'bun:test';
import { StoragePath } from '../../../src/storage/sandbox/rules-path.js';
import { formatPath, matchSegments, splitPath } from '../../../src/storage/sandbox/rules-path-match.js';

describe('Storage Rules path matching', () => {
  test('matches literals, parameters, and recursive wildcards without mutating prior params', () => {
    const prior = { bucket: 'media' };
    const matched = matchSegments([
      { kind: 'literal', value: 'uploads' },
      { kind: 'param', name: 'uid' },
      { kind: 'wildcard', name: 'tail' },
    ], splitPath('/uploads/alice/images/avatar.png'), prior, '2');

    expect(matched).toEqual({
      left: [],
      params: { bucket: 'media', uid: 'alice', tail: new StoragePath('/images/avatar.png') },
    });
    expect(prior).toEqual({ bucket: 'media' });
    expect(formatPath([
      { kind: 'literal', value: 'uploads' },
      { kind: 'param', name: 'uid' },
      { kind: 'wildcard', name: 'tail' },
    ])).toBe('/uploads/{uid}/{tail=**}');
  });

  test('ST-SIM-7: matches trailing segments after {name=**} and rejects non-matching tails', () => {
    const pattern = [
      { kind: 'wildcard' as const, name: 'prefix' },
      { kind: 'literal' as const, value: 'items' },
      { kind: 'param' as const, name: 'id' },
    ];
    expect(matchSegments(pattern, ['a', 'b', 'items', 'item42'], {}, '2')).toEqual({
      left: [],
      params: { prefix: new StoragePath('/a/b'), id: 'item42' },
    });
    expect(matchSegments(pattern, ['a', 'b', 'other', 'item42'], {}, '2')).toBeNull();
    expect(matchSegments(pattern, ['only-one'], {}, '2')).toBeNull();
  });

  test('ST-H1-2: a version 1 recursive wildcard needs one or more segments', () => {
    const pattern = [
      { kind: 'literal' as const, value: 'uploads' },
      { kind: 'wildcard' as const, name: 'rest' },
    ];
    expect(matchSegments(pattern, ['uploads'], {}, '1')).toBeNull();
    expect(matchSegments(pattern, ['uploads', 'a.png'], {}, '1')).toEqual({
      left: [],
      params: { rest: new StoragePath('/a.png') },
    });
    expect(matchSegments(pattern, ['uploads'], {}, '2')).toEqual({
      left: [],
      params: { rest: new StoragePath('/') },
    });
  });
});
