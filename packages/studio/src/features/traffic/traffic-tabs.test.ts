import { describe, expect, it } from 'bun:test';
import {
  queryForTrafficTab,
  resetTrafficSubrouteQuery,
  TRAFFIC_TABS,
  trafficTabForView,
} from './traffic-tabs.js';

describe('Traffic metric tabs', () => {
  it('offers only metrics backed by observed events', () => {
    expect(TRAFFIC_TABS).toEqual([
      { id: 'timeline', label: 'Timeline' },
      { id: 'billable', label: 'Billable metrics' },
      { id: 'rules', label: 'Rules' },
      { id: 'listeners', label: 'Listeners' },
    ]);
  });

  it('routes the observed metric views', () => {
    expect(trafficTabForView('billable')).toBe('billable');
    expect(trafficTabForView('rules')).toBe('rules');
    expect(trafficTabForView('listeners')).toBe('listeners');
  });

  it('redirects legacy subscription links to the remaining Rules view', () => {
    expect(trafficTabForView('subscriptions')).toBe('rules');
  });

  it('defaults unknown views to the timeline', () => {
    expect(trafficTabForView(undefined)).toBe('timeline');
    expect(trafficTabForView('unknown')).toBe('timeline');
  });

  it('clears ?inspect=, ?listener=, and ?target= when switching subtabs while preserving ?hide=studio and ?from=', () => {
    const initial = {
      inspect: 'ev-42',
      listener: 'l-1',
      target: '/rooms/r1',
      hide: 'studio',
      from: 'user:u-1',
    };
    expect(queryForTrafficTab(initial, 'billable')).toEqual({
      view: 'billable',
      hide: 'studio',
      from: 'user:u-1',
    });
    expect(
      queryForTrafficTab(
        { view: 'billable', inspect: 'ev-42', listener: 'l-1', target: '/rooms/r1', hide: 'studio' },
        'timeline',
      ),
    ).toEqual({
      hide: 'studio',
    });
    expect(initial.inspect).toBe('ev-42');
  });

  it('resets active Traffic subroutes back to the root timeline and returns null elsewhere', () => {
    expect(resetTrafficSubrouteQuery({ tab: 'firestore', rest: ['items'], query: {} })).toBeNull();
    expect(resetTrafficSubrouteQuery({ tab: 'traffic', rest: [], query: { hide: 'studio' } })).toBeNull();
    expect(
      resetTrafficSubrouteQuery({
        tab: 'traffic',
        rest: ['listeners', 'l-1'],
        query: { inspect: 'ev-1', view: 'listeners', hide: 'studio', from: 'user:u-1' },
      }),
    ).toEqual({ hide: 'studio', from: 'user:u-1' });
  });
});
