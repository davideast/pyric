/**
 * Listener rows: collapse, sort, and the journal's fold (feature: Listeners).
 *
 * PURE. A row is one target within one owner group. Listeners that share a
 * target and an owner label are the same thing attached more than once, so
 * they collapse into a single row carrying `×N`; the inspector on that row
 * lists the individual attaches.
 *
 * Delivery counts are supplied, not read off the listener: the journal counts
 * deliveries inside the displayed window, while `ActiveListener.deliveryCount`
 * is the whole session. A caller that wants the session total passes a
 * function that returns it.
 *
 * Sorting is one comparator per column, applied to rows inside a group and
 * then to the groups themselves (a group ranks by its own first row), so the
 * list reorders as a whole without the groups shuffling independently of
 * their contents. With no column chosen the default order runs rows with an
 * incident first, then by deliveries descending.
 */

import type { ActiveListener } from 'pyric/sandbox';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { formatListenerTarget, type ListenerGroup, type ListenerGroupIdentity } from './listener-groups.js';
import { incidentsForTarget } from './listener-incidents.js';
import type { ListenerFold } from './listener-facts.js';

export interface ListenerRow {
  readonly key: string;
  /** The listeners collapsed into this row, attach order. Always at least one. */
  readonly listeners: readonly ActiveListener[];
  /** The row's representative: the earliest-attached listener. */
  readonly listener: ActiveListener;
  /** The owner the row's group is filed under, repeated for the owner column. */
  readonly ownerLabel: string;
  /** The target as the app wrote it. */
  readonly target: string;
  /** How many listeners this row stands for; more than one renders `×N`. */
  readonly count: number;
  /** Deliveries in the displayed window, across the row's listeners. */
  readonly deliveryCount: number;
  readonly incidents: readonly ActivityIncident[];
}

export interface ListenerRowGroup {
  readonly identity: ListenerGroupIdentity;
  readonly rows: readonly ListenerRow[];
  /** Every listener in the group, across its rows. */
  readonly listenerCount: number;
}

export type ListenerSortColumn =
  | 'target'
  | 'service'
  | 'attached'
  | 'deliveries'
  | 'incident';

export type ListenerSortDirection = 'asc' | 'desc';

export interface ListenerSort {
  readonly column: ListenerSortColumn;
  readonly direction: ListenerSortDirection;
}

/** Click a header: first click sorts ascending, clicking the active column
 *  again reverses it. */
export function nextListenerSort(
  current: ListenerSort | undefined,
  column: ListenerSortColumn,
): ListenerSort {
  if (current?.column === column && current.direction === 'asc') {
    return { column, direction: 'desc' };
  }
  return { column, direction: 'asc' };
}

/** How many times one listener delivered. The default is the session total the
 *  fold already carries. */
export type DeliveriesFor = (listener: ActiveListener) => number;

const sessionDeliveries: DeliveriesFor = (listener) => listener.deliveryCount;

/** Collapse one group's listeners into rows keyed by target. */
function rowsFor(
  group: ListenerGroup,
  incidents: readonly ActivityIncident[],
  deliveriesFor: DeliveriesFor,
): readonly ListenerRow[] {
  const byTarget = new Map<string, ActiveListener[]>();
  for (const listener of group.listeners) {
    const target = formatListenerTarget(listener.target);
    const existing = byTarget.get(target);
    if (existing) existing.push(listener);
    else byTarget.set(target, [listener]);
  }
  return [...byTarget.entries()].map(([target, listeners]) => {
    const sorted = [...listeners].sort((a, b) => a.attachedAt - b.attachedAt);
    const first = sorted[0]!;
    return Object.freeze({
      key: `${group.identity.key}|${target}`,
      listeners: Object.freeze(sorted),
      listener: first,
      ownerLabel: group.identity.label,
      target,
      count: sorted.length,
      deliveryCount: sorted.reduce((sum, listener) => sum + deliveriesFor(listener), 0),
      incidents: incidentsForTarget(incidents, first.target),
    });
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rank for the incident column and the default order: a row with an
 *  incident outranks a quiet one. */
function incidentRank(row: ListenerRow): number {
  return row.incidents.length > 0 ? 1 : 0;
}

function compareColumn(a: ListenerRow, b: ListenerRow, column: ListenerSortColumn): number {
  if (column === 'target') return compareText(a.target, b.target);
  if (column === 'service') return compareText(a.listener.service, b.listener.service);
  if (column === 'attached') return a.listener.attachedAt - b.listener.attachedAt;
  if (column === 'deliveries') return a.deliveryCount - b.deliveryCount;
  return incidentRank(a) - incidentRank(b);
}

/** The default order: incidents first, then deliveries descending. Ties keep
 *  attach order so the list is stable across renders. */
function compareDefault(a: ListenerRow, b: ListenerRow): number {
  const byIncident = incidentRank(b) - incidentRank(a);
  if (byIncident !== 0) return byIncident;
  const byDeliveries = b.deliveryCount - a.deliveryCount;
  if (byDeliveries !== 0) return byDeliveries;
  return a.listener.attachedAt - b.listener.attachedAt;
}

function comparatorFor(sort: ListenerSort | undefined): (a: ListenerRow, b: ListenerRow) => number {
  if (sort === undefined) return compareDefault;
  const sign = sort.direction === 'asc' ? 1 : -1;
  return (a, b) => {
    const ordered = compareColumn(a, b, sort.column) * sign;
    return ordered !== 0 ? ordered : a.listener.attachedAt - b.listener.attachedAt;
  };
}

/** Build the sorted row groups: collapse duplicates, sort rows inside each
 *  group, then order the groups by their own first row. */
export function listenerRowGroups(
  groups: readonly ListenerGroup[],
  incidents: readonly ActivityIncident[],
  sort?: ListenerSort,
  deliveriesFor: DeliveriesFor = sessionDeliveries,
): readonly ListenerRowGroup[] {
  const compare = comparatorFor(sort);
  return groups
    .map((group) => {
      const rows = [...rowsFor(group, incidents, deliveriesFor)].sort(compare);
      return Object.freeze({
        identity: group.identity,
        rows: Object.freeze(rows),
        listenerCount: group.listeners.length,
      });
    })
    .sort((a, b) => compare(a.rows[0]!, b.rows[0]!));
}

/** The facts the journal header states, folded from the rows on screen: how
 *  many listeners, how many times each duplicated target was attached, the
 *  churn incidents, and the owner holding the most. */
export function listenerFold(
  rowGroups: readonly ListenerRowGroup[],
  incidents: readonly ActivityIncident[],
): ListenerFold {
  let listeners = 0;
  const duplicates: number[] = [];
  let busiest: { label: string; count: number } | undefined;
  for (const group of rowGroups) {
    listeners += group.listenerCount;
    if (busiest === undefined || group.listenerCount > busiest.count) {
      busiest = { label: group.identity.label, count: group.listenerCount };
    }
    for (const row of group.rows) {
      if (row.count > 1) duplicates.push(row.count);
    }
  }
  const churn = incidents.filter((incident) => incident.pattern === 'listener-churn').length;
  const fold: {
    listeners: number;
    duplicates: readonly number[];
    churn: number;
    busiest?: { label: string; count: number };
  } = { listeners, duplicates, churn };
  if (busiest !== undefined) fold.busiest = busiest;
  return fold;
}

/** The card totals the metric strip shows for one set of row groups. */
export function listenerCardTotals(rowGroups: readonly ListenerRowGroup[]): {
  delivering: number;
  idle: number;
  incidents: number;
} {
  let delivering = 0;
  let idle = 0;
  let withIncidents = 0;
  for (const group of rowGroups) {
    for (const row of group.rows) {
      if (row.deliveryCount > 0) delivering += row.count;
      else idle += row.count;
      if (row.incidents.length > 0) withIncidents += row.count;
    }
  }
  return { delivering, idle, incidents: withIncidents };
}

/** Which card keys a row belongs to. A row shows while any enabled card
 *  claims it, so unchecking `DELIVERING` still leaves an incident visible
 *  while `INCIDENTS` is on. */
export function cardKeysForRow(row: ListenerRow): readonly string[] {
  const keys = [row.deliveryCount > 0 ? 'delivering' : 'idle'];
  if (row.incidents.length > 0) keys.push('incidents');
  return keys;
}
