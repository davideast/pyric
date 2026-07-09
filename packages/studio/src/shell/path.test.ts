import { describe, it, expect } from 'bun:test';
import { parsePath, serializePath } from './path.js';

describe('studio path codec (History-API, N4)', () => {
  it('parses a tab-only path', () => {
    expect(parsePath('/firestore', '', '/')).toEqual({ tab: 'firestore', rest: [], query: {} });
  });

  it('parses tab + rest (Firestore doc path)', () => {
    expect(parsePath('/firestore/users/abc', '', '/')).toEqual({
      tab: 'firestore',
      rest: ['users', 'abc'],
      query: {},
    });
  });

  it('parses the query string', () => {
    expect(parsePath('/firestore/users/abc', '?denial=evt-1', '/')).toEqual({
      tab: 'firestore',
      rest: ['users', 'abc'],
      query: { denial: 'evt-1' },
    });
  });

  it('parses the root path to an empty tab', () => {
    expect(parsePath('/', '', '/')).toEqual({ tab: '', rest: [], query: {} });
    expect(parsePath('', '', '/')).toEqual({ tab: '', rest: [], query: {} });
  });

  it('strips the packaged app base (/__pyric/ui/)', () => {
    expect(parsePath('/__pyric/ui/firestore/users/abc', '?denial=evt-1', '/__pyric/ui/')).toEqual({
      tab: 'firestore',
      rest: ['users', 'abc'],
      query: { denial: 'evt-1' },
    });
    expect(parsePath('/__pyric/ui/', '', '/__pyric/ui/')).toEqual({ tab: '', rest: [], query: {} });
    expect(parsePath('/__pyric/ui', '', '/__pyric/ui/')).toEqual({ tab: '', rest: [], query: {} });
  });

  it('serializes tab + rest + query', () => {
    expect(
      serializePath({ tab: 'firestore', rest: ['users', 'abc'], query: { denial: 'evt-1' } }, '/'),
    ).toBe('/firestore/users/abc?denial=evt-1');
  });

  it('serializes under the packaged app base', () => {
    expect(serializePath({ tab: 'traffic', query: { denial: 'e1' } }, '/__pyric/ui/')).toBe(
      '/__pyric/ui/traffic?denial=e1',
    );
  });

  it('drops empty / undefined query values', () => {
    expect(serializePath({ tab: 'auth', rest: ['uid1'], query: { denial: undefined } }, '/')).toBe(
      '/auth/uid1',
    );
  });

  it('round-trips a storage object path', () => {
    const url = '/storage/uploads/logo.png?denial=evt-1';
    const p = parsePath('/storage/uploads/logo.png', '?denial=evt-1', '/');
    expect(serializePath({ tab: p.tab, rest: p.rest, query: p.query }, '/')).toBe(url);
  });

  it('round-trips under the packaged base', () => {
    const base = '/__pyric/ui/';
    const p = parsePath('/__pyric/ui/storage/a%20b/c%2Fd', '', base);
    expect(p.rest).toEqual(['a b', 'c/d']);
    expect(serializePath(p, base)).toBe('/__pyric/ui/storage/a%20b/c%2Fd');
  });

  it('url-encodes segments (slashes, spaces survive)', () => {
    expect(serializePath({ tab: 'storage', rest: ['a b', 'c/d'] }, '/')).toBe(
      '/storage/a%20b/c%2Fd',
    );
    expect(parsePath('/storage/a%20b/c%2Fd', '', '/').rest).toEqual(['a b', 'c/d']);
  });

  it('does not strip a base prefix from an unrelated sibling path', () => {
    expect(parsePath('/__pyric/uiobscure/x', '', '/__pyric/ui/')).toEqual({
      tab: '__pyric',
      rest: ['uiobscure', 'x'],
      query: {},
    });
  });
});
