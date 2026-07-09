import { describe, expect, it } from 'bun:test';
import { hrefFor } from './router.js';

describe('studio router hrefs', () => {
  it('serializes the home tab to the app base itself (specs/home.md: `/` is the hub)', () => {
    expect(hrefFor({ tab: 'home' })).toBe('/');
  });

  it('serializes other tabs under the base', () => {
    expect(hrefFor({ tab: 'traffic', query: { inspect: 'e1' } })).toBe('/traffic?inspect=e1');
    expect(hrefFor({ tab: 'firestore', rest: ['users', 'abc'] })).toBe('/firestore/users/abc');
  });
});
