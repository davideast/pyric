export type TrafficTab = 'timeline' | 'billable' | 'rules' | 'listeners';

export const TRAFFIC_TABS: ReadonlyArray<{ id: TrafficTab; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'billable', label: 'Billable metrics' },
  { id: 'rules', label: 'Rules' },
  { id: 'listeners', label: 'Listeners' },
];

/** Resolve a `?view=` value, preserving links to the removed subscriptions view. */
export function trafficTabForView(view: string | undefined): TrafficTab {
  if (view === 'billable') return 'billable';
  if (view === 'rules' || view === 'subscriptions') return 'rules';
  if (view === 'listeners') return 'listeners';
  return 'timeline';
}
