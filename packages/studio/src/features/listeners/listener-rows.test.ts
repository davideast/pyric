/** Listener rows: duplicate collapse, sorting, the fold, and the card totals. */
import { describe, expect, it } from 'bun:test';
import type { ActiveListener } from 'pyric/sandbox';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { groupListeners } from './listener-groups.js';
import {
  cardKeysForRow,
  listenerCardTotals,
  listenerFold,
  listenerRowGroups,
  nextListenerSort,
} from './listener-rows.js';

function listener(overrides: Partial<ActiveListener> & { id: string }): ActiveListener {
  return {
    service: 'firestore',
    target: 'notes/one',
    actor: { kind: 'app' },
    authLens: { mode: 'app-session' },
    attachedAt: 0,
    deliveryCount: 0,
    suppressedCount: 0,
    ...overrides,
  };
}

function incident(overrides: Partial<ActivityIncident>): ActivityIncident {
  return {
    fingerprint: 'f1',
    pattern: 'duplicate-listener',
    confidence: 'high',
    severity: 'warn',
    service: 'firestore',
    method: 'listen',
    targetFingerprint: JSON.stringify({ kind: 'doc', path: 'notes/one' }),
    actor: { kind: 'app' },
    authLens: 'app-session',
    authUid: null,
    count: 3,
    windowMs: 10_000,
    usage: { unit: 'listener-attaches', lowerBound: 3, limitations: [] },
    evidenceEventIds: [],
    sourceAttribution: { kind: 'unattributed' },
    ...overrides,
  } as ActivityIncident;
}

function rowsOf(listeners: readonly ActiveListener[], incidents: readonly ActivityIncident[] = []) {
  return listenerRowGroups(groupListeners(listeners), incidents);
}

describe('duplicate collapse', () => {
  it('collapses listeners sharing a target and an owner into one row', () => {
    const owners = [{ kind: 'tag' as const, name: 'sidebar' }];
    const groups = rowsOf([
      listener({ id: 'a', owners, deliveryCount: 2 }),
      listener({ id: 'b', owners, deliveryCount: 3 }),
      listener({ id: 'c', owners, deliveryCount: 1 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(1);
    const row = groups[0]!.rows[0]!;
    expect(row.count).toBe(3);
    expect(row.deliveryCount).toBe(6);
    expect(row.listeners.map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps separate targets as separate rows', () => {
    const owners = [{ kind: 'tag' as const, name: 'sidebar' }];
    const groups = rowsOf([
      listener({ id: 'a', owners, target: 'notes/one' }),
      listener({ id: 'b', owners, target: 'notes/two' }),
    ]);
    expect(groups[0]!.rows.map((r) => r.target)).toEqual(['notes/one', 'notes/two']);
    expect(groups[0]!.rows.every((r) => r.count === 1)).toBe(true);
  });

  it('counts deliveries with the supplied lookup, not the session total', () => {
    const owners = [{ kind: 'tag' as const, name: 'sidebar' }];
    const groups = listenerRowGroups(
      groupListeners([
        listener({ id: 'a', owners, deliveryCount: 99 }),
        listener({ id: 'b', owners, deliveryCount: 99 }),
      ]),
      [],
      undefined,
      (l) => (l.id === 'a' ? 2 : 0),
    );
    expect(groups[0]!.rows[0]!.deliveryCount).toBe(2);
  });
});

describe('sorting', () => {
  const listeners = [
    listener({ id: 'quiet', target: 'quiet/one', deliveryCount: 1, attachedAt: 1 }),
    listener({ id: 'busy', target: 'busy/one', deliveryCount: 9, attachedAt: 2 }),
    listener({ id: 'flagged', target: 'notes/one', deliveryCount: 0, attachedAt: 3 }),
  ];
  const incidents = [incident({})];

  it('defaults to incidents first, then deliveries descending', () => {
    const groups = listenerRowGroups(groupListeners(listeners), incidents);
    expect(groups.map((g) => g.rows[0]!.target)).toEqual(['notes/one', 'busy/one', 'quiet/one']);
  });

  it('sorts by a column in either direction', () => {
    const asc = listenerRowGroups(groupListeners(listeners), incidents, {
      column: 'deliveries',
      direction: 'asc',
    });
    expect(asc.map((g) => g.rows[0]!.deliveryCount)).toEqual([0, 1, 9]);
    const desc = listenerRowGroups(groupListeners(listeners), incidents, {
      column: 'deliveries',
      direction: 'desc',
    });
    expect(desc.map((g) => g.rows[0]!.deliveryCount)).toEqual([9, 1, 0]);
  });

  it('sorts by target text', () => {
    const groups = listenerRowGroups(groupListeners(listeners), [], {
      column: 'target',
      direction: 'asc',
    });
    expect(groups.map((g) => g.rows[0]!.target)).toEqual(['busy/one', 'notes/one', 'quiet/one']);
  });

  it('reverses a column on a second click and restarts ascending on a new one', () => {
    expect(nextListenerSort(undefined, 'deliveries')).toEqual({
      column: 'deliveries',
      direction: 'asc',
    });
    expect(nextListenerSort({ column: 'deliveries', direction: 'asc' }, 'deliveries')).toEqual({
      column: 'deliveries',
      direction: 'desc',
    });
    expect(nextListenerSort({ column: 'deliveries', direction: 'desc' }, 'target')).toEqual({
      column: 'target',
      direction: 'asc',
    });
  });
});

describe('the fold behind the journal header', () => {
  it('counts listeners, idle listeners, duplicates, churn, and the busiest owner', () => {
    const owners = [{ kind: 'component' as const, name: 'ChatPage' }];
    const groups = listenerRowGroups(
      groupListeners([
        listener({ id: 'a', owners, target: 'notes/one' }),
        listener({ id: 'b', owners, target: 'notes/one' }),
        listener({ id: 'c', owners, target: 'notes/two' }),
        listener({ id: 'd', target: 'other/one' }),
      ]),
      [],
      undefined,
      (l) => (l.id === 'c' ? 4 : 0),
    );
    const fold = listenerFold(groups, [incident({ pattern: 'listener-churn' })]);
    expect(fold.listeners).toBe(4);
    expect(fold.idle).toBe(3);
    expect(fold.churn).toBe(1);
    expect(fold.duplicates).toEqual([{ target: 'notes/one', count: 2 }]);
    expect(fold.busiest).toEqual({ label: 'ChatPage', count: 3 });
  });
});

describe('the card totals and the row filter', () => {
  it('splits listeners into delivering, idle, and those with an incident', () => {
    const groups = listenerRowGroups(
      groupListeners([
        listener({ id: 'a', target: 'notes/one' }),
        listener({ id: 'b', target: 'busy/one' }),
      ]),
      [incident({})],
      undefined,
      (l) => (l.id === 'b' ? 3 : 0),
    );
    expect(listenerCardTotals(groups)).toEqual({ delivering: 1, idle: 1, incidents: 1 });
  });

  it('claims a flagged row for both its delivery state and the incident card', () => {
    const groups = listenerRowGroups(
      groupListeners([listener({ id: 'a', target: 'notes/one' })]),
      [incident({})],
    );
    expect(cardKeysForRow(groups[0]!.rows[0]!)).toEqual(['idle', 'incidents']);
  });
});
