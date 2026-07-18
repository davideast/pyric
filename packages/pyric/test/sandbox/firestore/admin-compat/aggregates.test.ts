/**
 * `Query.aggregate(spec)` — Tier 2 / v1 scope-survey gap.
 *
 * Server-side aggregates collapsed into one method (we don't model
 * production's `query.aggregate(...).get()` two-step because the
 * sandbox has no remote dispatch — the second `.get()` would be a
 * no-op wrapper around an already-computed value).
 *
 * Pins:
 *   - `count` over an entire collection, over a `where`-filtered set,
 *     and over an empty input
 *   - `sum` skips non-numeric values silently (matches production)
 *   - `average` returns `null` on empty inputs (matches the JS SDK
 *     `AggregateField.average` contract)
 *   - Multiple aggregates in one spec all compute against the same
 *     filtered set
 *   - Cross-collection: `collectionGroup` inherits the aggregate
 *     plumbing for free via the shared `gatherCandidates` hook
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { FirestoreImpl } from '../../../../src/firestore/sandbox/admin-compat/firestore.js';

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
      'tickets/T-1': { priority: 1, status: 'open',   estimate: 3 },
      'tickets/T-2': { priority: 3, status: 'open',   estimate: 5 },
      'tickets/T-3': { priority: 2, status: 'closed', estimate: null }, // non-numeric estimate
      'tickets/T-4': { priority: 5, status: 'open',   estimate: 8 },
      // Nested ticket under a project — covered by collectionGroup.
      'projects/P1/tickets/T-5': { priority: 4, status: 'open', estimate: 2 },
    },
  });
  return new FirestoreImpl(env, { uid: 'alice', token: {} });
}

describe('Query.aggregate', () => {
  it('count returns the total document count of the matching set', async () => {
    const db = setup();
    const snap = await db.collection('tickets').aggregate({ total: { kind: 'count' } });
    expect(snap.data()).toEqual({ total: 4 });
  });

  it('count honors where clauses before counting', async () => {
    const db = setup();
    const snap = await db
      .collection('tickets')
      .where('status', '==', 'open')
      .aggregate({ openCount: { kind: 'count' } });
    expect(snap.data()).toEqual({ openCount: 3 });
  });

  it('count returns 0 on empty input', async () => {
    const db = setup();
    const snap = await db.collection('nothing').aggregate({ total: { kind: 'count' } });
    expect(snap.data()).toEqual({ total: 0 });
  });

  it('sum totals numeric values and ignores non-numeric ones', async () => {
    const db = setup();
    const snap = await db.collection('tickets').aggregate({
      totalEstimate: { kind: 'sum', field: 'estimate' },
    });
    // T-1:3 + T-2:5 + T-4:8 — T-3 has null estimate, skipped.
    expect(snap.data()).toEqual({ totalEstimate: 16 });
  });

  it('average over numeric values', async () => {
    const db = setup();
    const snap = await db.collection('tickets').aggregate({
      avgPriority: { kind: 'average', field: 'priority' },
    });
    // (1+3+2+5)/4 = 2.75
    expect(snap.data()).toEqual({ avgPriority: 2.75 });
  });

  it('average returns null on empty / all-non-numeric input', async () => {
    const db = setup();
    const snap = await db.collection('nothing').aggregate({
      avg: { kind: 'average', field: 'x' },
    });
    expect(snap.data()).toEqual({ avg: null });
  });

  it('multiple aggregates compute against the same filtered set', async () => {
    const db = setup();
    const snap = await db
      .collection('tickets')
      .where('status', '==', 'open')
      .aggregate({
        n: { kind: 'count' },
        totalEstimate: { kind: 'sum', field: 'estimate' },
        avgPriority: { kind: 'average', field: 'priority' },
      });
    expect(snap.data()).toEqual({
      n: 3,
      totalEstimate: 16,     // T-1:3 + T-2:5 + T-4:8
      avgPriority: 3,        // (1+3+5)/3
    });
  });

  it('collectionGroup inherits aggregate for free', async () => {
    const db = setup();
    const snap = await db.collectionGroup('tickets').aggregate({
      total: { kind: 'count' },
      avgPriority: { kind: 'average', field: 'priority' },
    });
    // Top-level T-1..T-4 + nested T-5 = 5 docs; priorities 1+3+2+5+4 = 15/5 = 3
    expect(snap.data()).toEqual({ total: 5, avgPriority: 3 });
  });

  it('limit caps the aggregate input', async () => {
    const db = setup();
    const snap = await db
      .collection('tickets')
      .orderBy('priority')
      .limit(2)
      .aggregate({ n: { kind: 'count' } });
    expect(snap.data()).toEqual({ n: 2 });
  });
});
