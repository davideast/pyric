/** The Listeners deep link — pure query-string decode tests. */
import { describe, expect, it } from 'bun:test';
import { parseListenersDeepLink } from './listeners-deep-link.js';

describe('parseListenersDeepLink', () => {
  it('is closed when view is not listeners', () => {
    expect(parseListenersDeepLink('?view=traffic')).toEqual({ open: false });
    expect(parseListenersDeepLink('')).toEqual({ open: false });
  });

  it('opens with the listener id and target prefix', () => {
    expect(parseListenersDeepLink('?view=listeners&listener=l1&target=notes')).toEqual({
      open: true,
      listenerId: 'l1',
      targetPrefix: 'notes',
    });
  });

  it('opens with only view when listener/target are absent', () => {
    expect(parseListenersDeepLink('?view=listeners')).toEqual({ open: true });
  });
});
