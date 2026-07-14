import { describe, expect, it } from 'bun:test';
import { TRAFFIC_TABS, trafficTabForView } from './traffic-tabs.js';

describe('Traffic metric tabs', () => {
  it('offers only metrics backed by observed events', () => {
    expect(TRAFFIC_TABS).toEqual([
      { id: 'timeline', label: 'Timeline' },
      { id: 'billable', label: 'Billable metrics' },
      { id: 'rules', label: 'Rules' },
    ]);
  });

  it('routes the observed metric views', () => {
    expect(trafficTabForView('billable')).toBe('billable');
    expect(trafficTabForView('rules')).toBe('rules');
  });

  it('redirects legacy subscription links to the remaining Rules view', () => {
    expect(trafficTabForView('subscriptions')).toBe('rules');
  });

  it('defaults unknown views to the timeline', () => {
    expect(trafficTabForView(undefined)).toBe('timeline');
    expect(trafficTabForView('unknown')).toBe('timeline');
  });
});
