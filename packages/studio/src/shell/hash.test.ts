import { describe, it, expect } from 'bun:test';
import { parseHash, serializeHash } from './hash.js';

describe('studio hash codec', () => {
  it('parses a tab-only hash', () => {
    expect(parseHash('#firestore')).toEqual({ tab: 'firestore', rest: [], query: {} });
  });

  it('parses tab + rest (Firestore doc path)', () => {
    expect(parseHash('#firestore/users/abc')).toEqual({
      tab: 'firestore',
      rest: ['users', 'abc'],
      query: {},
    });
  });

  it('parses the lens query', () => {
    expect(parseHash('#firestore/users/abc?lens=app')).toEqual({
      tab: 'firestore',
      rest: ['users', 'abc'],
      query: { lens: 'app' },
    });
  });

  it('parses an empty hash to an empty tab', () => {
    expect(parseHash('')).toEqual({ tab: '', rest: [], query: {} });
    expect(parseHash('#')).toEqual({ tab: '', rest: [], query: {} });
  });

  it('serializes tab + rest + query', () => {
    expect(serializeHash({ tab: 'firestore', rest: ['users', 'abc'], query: { lens: 'app' } })).toBe(
      '#firestore/users/abc?lens=app',
    );
  });

  it('drops empty / undefined query values (admin lens = no query)', () => {
    expect(serializeHash({ tab: 'auth', rest: ['uid1'], query: { lens: undefined } })).toBe('#auth/uid1');
  });

  it('round-trips a storage object path', () => {
    const h = '#storage/uploads/logo.png?lens=app';
    const p = parseHash(h);
    expect(serializeHash({ tab: p.tab, rest: p.rest, query: p.query })).toBe(h);
  });

  it('url-encodes segments (slashes, spaces survive)', () => {
    expect(serializeHash({ tab: 'storage', rest: ['a b', 'c/d'] })).toBe('#storage/a%20b/c%2Fd');
    expect(parseHash('#storage/a%20b/c%2Fd').rest).toEqual(['a b', 'c/d']);
  });
});
