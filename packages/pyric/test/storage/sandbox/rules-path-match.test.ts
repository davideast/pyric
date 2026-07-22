import { describe, expect, test } from 'bun:test';
import { formatPath, matchSegments, splitPath } from '../../../src/storage/sandbox/rules-path-match.js';

describe('Storage Rules path matching', () => {
  test('matches literals, parameters, and recursive wildcards without mutating prior params', () => {
    const prior = { bucket: 'media' };
    const matched = matchSegments([
      { kind: 'literal', value: 'uploads' },
      { kind: 'param', name: 'uid' },
      { kind: 'wildcard', name: 'tail' },
    ], splitPath('/uploads/alice/images/avatar.png'), prior);

    expect(matched).toEqual({
      left: [],
      params: { bucket: 'media', uid: 'alice', tail: ['images', 'avatar.png'] },
    });
    expect(prior).toEqual({ bucket: 'media' });
    expect(formatPath([
      { kind: 'literal', value: 'uploads' },
      { kind: 'param', name: 'uid' },
      { kind: 'wildcard', name: 'tail' },
    ])).toBe('/uploads/{uid}/{tail=**}');
  });
});
