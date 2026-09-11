/** The Listeners deep link, pure query-string decode tests. */
import { describe, expect, it } from 'bun:test';
import { listenersDeepLinkFromQuery, parseListenersDeepLink } from './listeners-deep-link.js';
import { trafficTabForView } from '../traffic/traffic-tabs.js';

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

describe('the deep link on the Traffic tab', () => {
  it('names the Listeners view', () => {
    expect(trafficTabForView('listeners')).toBe('listeners');
  });

  it('reads back the selected listener from the routed query', () => {
    expect(
      listenersDeepLinkFromQuery({ view: 'listeners', listener: 'l1', target: 'notes' }),
    ).toEqual({ open: true, listenerId: 'l1', targetPrefix: 'notes' });
  });

  it('is closed on the other Traffic views', () => {
    expect(listenersDeepLinkFromQuery({ view: 'billable' })).toEqual({ open: false });
    expect(listenersDeepLinkFromQuery({})).toEqual({ open: false });
  });
});
