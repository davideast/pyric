/**
 * `Query.applyFilter(filter)` — Tier 2 / v1 scope-survey gap.
 *
 * Pins the composite-filter evaluator. The leaf semantics (where)
 * are unchanged from `Query.where(field, op, value)`; the new
 * behaviors verified here are AND-of-leaves, OR-of-leaves, nested
 * AND/OR, and how composite filters interact with the
 * implicit-AND-across-filter-array semantics of `Query.where` +
 * `applyFilter` chained together.
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { FirestoreImpl } from '../../../../src/sandbox/firestore/admin-compat/firestore.js';
import type { Filter } from '../../../../src/sandbox/firestore/admin-compat/types.js';

const RULES_AUTH_OPEN = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

function setup(): FirestoreImpl {
  const env = new LocalEnvironment();
  env.deployRules(RULES_AUTH_OPEN);
  env.seed({
    rules: RULES_AUTH_OPEN,
    documents: {
      'tickets/T-1': { priority: 1, status: 'open',     assignee: 'alice' },
      'tickets/T-2': { priority: 5, status: 'open',     assignee: 'bob' },
      'tickets/T-3': { priority: 2, status: 'closed',   assignee: 'alice' },
      'tickets/T-4': { priority: 4, status: 'closed',   assignee: 'carol' },
      'tickets/T-5': { priority: 3, status: 'archived', assignee: 'alice' },
    },
  });
  return new FirestoreImpl(env, { uid: 'alice', token: {} });
}

describe('Query.applyFilter — composite filters', () => {
  it('OR matches docs where any sub-filter matches', async () => {
    const db = setup();
    const orFilter: Filter = {
      kind: 'or',
      filters: [
        { kind: 'where', field: 'status', op: '==', value: 'open' },
        { kind: 'where', field: 'priority', op: '==', value: 3 },
      ],
    };
    const snap = await db.collection('tickets').applyFilter(orFilter).get();
    const ids = snap.docs.map((d) => d.id).sort();
    expect(ids).toEqual(['T-1', 'T-2', 'T-5']); // open OR priority=3
  });

  it('AND requires every sub-filter to match', async () => {
    const db = setup();
    const andFilter: Filter = {
      kind: 'and',
      filters: [
        { kind: 'where', field: 'status', op: '==', value: 'closed' },
        { kind: 'where', field: 'priority', op: '>=', value: 3 },
      ],
    };
    const snap = await db.collection('tickets').applyFilter(andFilter).get();
    expect(snap.docs.map((d) => d.id)).toEqual(['T-4']); // closed AND prio>=3
  });

  it('nested AND inside OR — the production composite pattern', async () => {
    const db = setup();
    // (status == 'open') OR (status == 'closed' AND assignee == 'alice')
    const filter: Filter = {
      kind: 'or',
      filters: [
        { kind: 'where', field: 'status', op: '==', value: 'open' },
        {
          kind: 'and',
          filters: [
            { kind: 'where', field: 'status', op: '==', value: 'closed' },
            { kind: 'where', field: 'assignee', op: '==', value: 'alice' },
          ],
        },
      ],
    };
    const snap = await db.collection('tickets').applyFilter(filter).get();
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['T-1', 'T-2', 'T-3']);
  });

  it('combines with .where() via implicit-AND across the filter array', async () => {
    const db = setup();
    const orFilter: Filter = {
      kind: 'or',
      filters: [
        { kind: 'where', field: 'priority', op: '==', value: 1 },
        { kind: 'where', field: 'priority', op: '==', value: 4 },
      ],
    };
    // The where + applyFilter compose with AND. So this resolves to
    // assignee=alice AND (priority=1 OR priority=4) — only T-1.
    const snap = await db
      .collection('tickets')
      .where('assignee', '==', 'alice')
      .applyFilter(orFilter)
      .get();
    expect(snap.docs.map((d) => d.id)).toEqual(['T-1']);
  });

  it('empty OR matches nothing; empty AND matches everything', async () => {
    const db = setup();
    const emptyOr: Filter = { kind: 'or', filters: [] };
    const emptyAnd: Filter = { kind: 'and', filters: [] };
    expect((await db.collection('tickets').applyFilter(emptyOr).get()).size).toBe(0);
    expect((await db.collection('tickets').applyFilter(emptyAnd).get()).size).toBe(5);
  });

  it('aggregates over a composite-filtered set', async () => {
    const db = setup();
    const orFilter: Filter = {
      kind: 'or',
      filters: [
        { kind: 'where', field: 'status', op: '==', value: 'open' },
        { kind: 'where', field: 'priority', op: '==', value: 3 },
      ],
    };
    const snap = await db
      .collection('tickets')
      .applyFilter(orFilter)
      .aggregate({ n: { kind: 'count' } });
    expect(snap.data()).toEqual({ n: 3 });
  });
});
