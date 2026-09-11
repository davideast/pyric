/**
 * Listener rows: collapse, sort, and the counts header (feature: Listeners).
 *
 * PURE. A row is one target within one owner group. Listeners that share a
 * target and an owner label are the same thing attached more than once, so
 * they collapse into a single row carrying `×N`; expanding the row shows the
 * individual listeners again.
 *
 * Sorting is one comparator per column, applied to rows inside a group and
 * then to the groups themselves (a group ranks by its own first row), so the
 * table reorders as a whole without the groups shuffling independently of
 * their contents. With no column chosen the default order runs rows with an
 * incident first, then by deliveries descending.
 */

import type { ActiveListener } from 'pyric/sandbox';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { formatListenerTarget, type ListenerGroup, type ListenerGroupIdentity } from './listener-groups.js';
import { incidentsForTarget } from './listener-incidents.js';

export interface ListenerRow {
  readonly key: string;
  /** The listeners collapsed into this row, attach order. Always at least one. */
  readonly listeners: readonly ActiveListener[];
  /** The row's representative: the earliest-attached listener. */
  readonly listener: ActiveListener;
  /** The target as the app wrote it. */
  readonly target: string;
  /** How many listeners this row stands for; more than one renders `×N`. */
  readonly count: number;
  readonly deliveryCount: number;
  readonly suppressedCount: number;
  readonly lastDeliveryAt?: number;
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
  | 'actor'
  | 'attached'
  | 'deliveries'
  | 'suppressed'
  | 'lastDelivery'
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

function actorLabelOf(listener: ActiveListener): string {
  const actor = listener.actor;
  return actor.kind === 'agent' ? `agent ${actor.name}` : actor.kind;
}

/** Collapse one group's listeners into rows keyed by target. */
function rowsFor(
  group: ListenerGroup,
  incidents: readonly ActivityIncident[],
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
    const lastDeliveryAt = sorted.reduce<number | undefined>((latest, listener) => {
      if (listener.lastDeliveryAt === undefined) return latest;
      return latest === undefined || listener.lastDeliveryAt > latest
        ? listener.lastDeliveryAt
        : latest;
    }, undefined);
    const row: {
      key: string;
      listeners: readonly ActiveListener[];
      listener: ActiveListener;
      target: string;
      count: number;
      deliveryCount: number;
      suppressedCount: number;
      lastDeliveryAt?: number;
      incidents: readonly ActivityIncident[];
    } = {
      key: `${group.identity.key}|${target}`,
      listeners: sorted,
      listener: first,
      target,
      count: sorted.length,
      deliveryCount: sorted.reduce((sum, listener) => sum + listener.deliveryCount, 0),
      suppressedCount: sorted.reduce((sum, listener) => sum + listener.suppressedCount, 0),
      incidents: incidentsForTarget(incidents, first.target),
    };
    if (lastDeliveryAt !== undefined) row.lastDeliveryAt = lastDeliveryAt;
    return Object.freeze(row);
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumber(a: number, b: number): number {
  return a - b;
}

/** Rank for the incident column and the default order: a row with an
 *  incident outranks a quiet one. */
function incidentRank(row: ListenerRow): number {
  return row.incidents.length > 0 ? 1 : 0;
}

function compareColumn(a: ListenerRow, b: ListenerRow, column: ListenerSortColumn): number {
  if (column === 'target') return compareText(a.target, b.target);
  if (column === 'service') return compareText(a.listener.service, b.listener.service);
  if (column === 'actor') return compareText(actorLabelOf(a.listener), actorLabelOf(b.listener));
  if (column === 'attached') return compareNumber(a.listener.attachedAt, b.listener.attachedAt);
  if (column === 'deliveries') return compareNumber(a.deliveryCount, b.deliveryCount);
  if (column === 'suppressed') return compareNumber(a.suppressedCount, b.suppressedCount);
  if (column === 'lastDelivery') {
    return compareNumber(a.lastDeliveryAt ?? 0, b.lastDeliveryAt ?? 0);
  }
  return compareNumber(incidentRank(a), incidentRank(b));
}

/** The default order: incidents first, then deliveries descending. Ties keep
 *  attach order so the table is stable across renders. */
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
): readonly ListenerRowGroup[] {
  const compare = comparatorFor(sort);
  return groups
    .map((group) => {
      const rows = [...rowsFor(group, incidents)].sort(compare);
      return Object.freeze({
        identity: group.identity,
        rows: Object.freeze(rows),
        listenerCount: group.listeners.length,
      });
    })
    .sort((a, b) => compare(a.rows[0]!, b.rows[0]!));
}

export interface ListenerCounts {
  readonly listeners: number;
  readonly duplicates: number;
  readonly churn: number;
}

/** The pinned header's counts: how many listeners are attached, and how many
 *  duplicate and churn incidents the activity monitor raised over them. */
export function listenerCounts(
  listeners: readonly ActiveListener[],
  incidents: readonly ActivityIncident[],
): ListenerCounts {
  return {
    listeners: listeners.length,
    duplicates: incidents.filter((incident) => incident.pattern === 'duplicate-listener').length,
    churn: incidents.filter((incident) => incident.pattern === 'listener-churn').length,
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The counts header as one line: `12 listeners · 2 duplicates · 1 churn`.
 *  A zero count is left out rather than shown as nothing to look at. */
export function formatListenerCounts(counts: ListenerCounts): string {
  const parts = [plural(counts.listeners, 'listener')];
  if (counts.duplicates > 0) parts.push(plural(counts.duplicates, 'duplicate'));
  if (counts.churn > 0) parts.push(`${counts.churn} churn`);
  return parts.join(' · ');
}

/** Groups start collapsed once the table has more than this many of them:
 *  past this point the group labels are the table, and the rows are detail. */
export const COLLAPSE_GROUPS_ABOVE = 20;
