import { INSPECT_PARAM } from './inspect-selection.js';

export type TrafficTab = 'timeline' | 'billable' | 'rules' | 'listeners';

const TRAFFIC_FOCUS_QUERY_KEYS = [INSPECT_PARAM, 'listener', 'target'] as const;

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

/**
 * Next URL query when switching Traffic subtabs: clears stale `?inspect=`,
 * `?listener=`, and `?target=` focus while preserving ambient filters
 * (`?hide=studio`, `?from=`).
 */
export function queryForTrafficTab(
  current: Record<string, string | undefined>,
  tab: TrafficTab,
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...current };
  for (const key of TRAFFIC_FOCUS_QUERY_KEYS) delete next[key];
  if (tab === 'timeline') {
    delete next.view;
  } else {
    next.view = tab;
  }
  return next;
}

/**
 * Resets a re-clicked Traffic rail destination back to its root timeline while
 * preserving ambient filters (`?hide=studio`, `?from=`), or returns `null` when
 * already at the root timeline.
 */
export function resetTrafficSubrouteQuery(location: {
  readonly tab: string;
  readonly rest: readonly string[];
  readonly query: Record<string, string | undefined>;
}): Record<string, string | undefined> | null {
  if (location.tab !== 'traffic') return null;
  const hasFocusKey = TRAFFIC_FOCUS_QUERY_KEYS.some((key) => location.query[key] !== undefined);
  const hasSubroute = location.rest.length > 0 || location.query.view !== undefined || hasFocusKey;
  if (!hasSubroute) return null;
  return queryForTrafficTab(location.query, 'timeline');
}
