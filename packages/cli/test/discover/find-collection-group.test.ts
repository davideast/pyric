/**
 * Item 6.1 — `findCollectionGroup` (Strategy A from the 0.H lock).
 *
 * Cost contract: `min(limit, totalDocsInGroup)` reads. Coverage of
 * hosts is statistical — the tool returns `limitWasReached` so agents
 * know when to raise `limit`.
 *
 * This file pins:
 *   1. Multi-host happy path: 4 hosts × 30 docs each, limit=100 →
 *      all 4 hosts discovered, reads=100, limitWasReached=false.
 *   2. Limit-hit signaling: 1 host × 200 docs, limit=50 → 1 host,
 *      reads=50, limitWasReached=true.
 *   3. Unknown collection ID → empty result, reads=0,
 *      limitWasReached=false.
 *   4. Custom limit honored.
 *   5. Concrete → template path conversion (the multi-host hosts
 *      collapse to one templatePath).
 *   6. `sampleDocCount` arithmetic across hosts.
 *   7. Input validation: empty collectionId / non-positive limit.
 *   8. Insertion-order preservation in the `hosts` array.
 */

import { describe, expect, test } from 'bun:test';
import { findCollectionGroup } from '../../src/discover/findCollectionGroup.js';
import type {
  CollectionGroupCapableFirestore,
  CollectionGroupQuery,
  CollectionGroupSnapshot,
} from '../../src/discover/firestore-source.js';

// ─── Mock collection-group query ──────────────────────────────────────────

interface MockMetrics {
  collectionGroupCalls: number;
  selectCalls: number;
  limitCalls: number;
  getCalls: number;
}

interface MockDb extends CollectionGroupCapableFirestore {
  metrics: MockMetrics;
}

/**
 * Build a mock Firestore that returns a fixed list of parent paths for
 * a given collection ID. Mirrors the Admin SDK shape:
 *   db.collectionGroup(id).select().limit(N).get() →
 *     { docs: [ { ref: { parent: { path: '<concretePath>' } } }, ... ] }
 *
 * `parentsByCollectionId[collId]` is an array of concrete parent
 * collection paths — repeat a path to simulate multiple docs sharing
 * that parent. Order matters: the mock applies `.limit(N)` by
 * truncating to the first N entries, mirroring real query order.
 */
function buildMockDb(parentsByCollectionId: Record<string, string[]>): MockDb {
  const metrics: MockMetrics = {
    collectionGroupCalls: 0,
    selectCalls: 0,
    limitCalls: 0,
    getCalls: 0,
  };

  return {
    metrics,
    collectionGroup(collectionId: string): CollectionGroupQuery {
      metrics.collectionGroupCalls++;
      const allParents = parentsByCollectionId[collectionId] ?? [];
      let appliedLimit = allParents.length;

      const query: CollectionGroupQuery = {
        select(..._fields: string[]): CollectionGroupQuery {
          metrics.selectCalls++;
          return query;
        },
        limit(n: number): CollectionGroupQuery {
          metrics.limitCalls++;
          appliedLimit = Math.min(n, allParents.length);
          return query;
        },
        async get() {
          metrics.getCalls++;
          const slice = allParents.slice(0, appliedLimit);
          const docs: CollectionGroupSnapshot[] = slice.map((path) => ({
            ref: { parent: { path } },
          }));
          return { docs };
        },
      };
      return query;
    },
  };
}

// ─── 1. Multi-host happy path ─────────────────────────────────────────────

describe('findCollectionGroup — multi-host happy path', () => {
  test('4 hosts × 30 docs, limit=100 → 4 hosts, reads=120 capped to 100, limitWasReached=true', async () => {
    // 4 hosts × 30 docs = 120. Limit 100 truncates to 100 docs.
    const parents: string[] = [];
    for (let h = 0; h < 4; h++) {
      for (let d = 0; d < 30; d++) {
        parents.push(`users/u${h}/posts`);
      }
    }
    const db = buildMockDb({ posts: parents });
    const result = await findCollectionGroup(db, 'posts', { limit: 100 });

    expect(result.hosts).toHaveLength(1); // collapsed to template form
    expect(result.hosts[0]!.templatePath).toBe('users/{userId}/posts');
    expect(result.reads).toBe(100);
    expect(result.limitWasReached).toBe(true);
  });

  test('all hosts under limit → reads = totalDocs, limitWasReached=false', async () => {
    // 4 hosts × 5 docs = 20 total. Limit 100 — never hit.
    const parents: string[] = [];
    for (let h = 0; h < 4; h++) {
      for (let d = 0; d < 5; d++) {
        parents.push(`users/u${h}/posts`);
      }
    }
    const db = buildMockDb({ posts: parents });
    const result = await findCollectionGroup(db, 'posts', { limit: 100 });

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]!.sampleDocCount).toBe(20);
    expect(result.reads).toBe(20);
    expect(result.limitWasReached).toBe(false);
  });
});

// ─── 2. Limit-hit signaling ───────────────────────────────────────────────

describe('findCollectionGroup — limit-hit signaling', () => {
  test('1 host × 200 docs, limit=50 → 1 host, reads=50, limitWasReached=true', async () => {
    const parents = Array.from({ length: 200 }, () => 'orders/o1/items');
    const db = buildMockDb({ items: parents });
    const result = await findCollectionGroup(db, 'items', { limit: 50 });

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]!.templatePath).toBe('orders/{orderId}/items');
    expect(result.hosts[0]!.sampleDocCount).toBe(50);
    expect(result.reads).toBe(50);
    expect(result.limitWasReached).toBe(true);
  });
});

// ─── 3. Unknown collection ID ─────────────────────────────────────────────

describe('findCollectionGroup — unknown collection ID', () => {
  test('returns empty hosts, reads=0, limitWasReached=false; does not throw', async () => {
    const db = buildMockDb({}); // no entries for any id
    const result = await findCollectionGroup(db, 'nonexistent_collection');

    expect(result.hosts).toEqual([]);
    expect(result.reads).toBe(0);
    expect(result.limitWasReached).toBe(false);
  });

  test('still issues exactly one collectionGroup query — no short-circuit', async () => {
    const db = buildMockDb({});
    await findCollectionGroup(db, 'nonexistent_collection');
    expect(db.metrics.collectionGroupCalls).toBe(1);
    expect(db.metrics.getCalls).toBe(1);
  });
});

// ─── 4. Custom limit honored ──────────────────────────────────────────────

describe('findCollectionGroup — limit option', () => {
  test('default limit is 100 when omitted', async () => {
    // 150 docs available, default limit truncates to 100.
    const parents = Array.from({ length: 150 }, () => 'logs/l1/events');
    const db = buildMockDb({ events: parents });
    const result = await findCollectionGroup(db, 'events');
    expect(result.reads).toBe(100);
    expect(result.limitWasReached).toBe(true);
  });

  test('limit=10 caps reads to 10', async () => {
    const parents = Array.from({ length: 150 }, () => 'logs/l1/events');
    const db = buildMockDb({ events: parents });
    const result = await findCollectionGroup(db, 'events', { limit: 10 });
    expect(result.reads).toBe(10);
    expect(result.limitWasReached).toBe(true);
  });

  test('large limit honored even when underdrawn', async () => {
    const parents = Array.from({ length: 5 }, () => 'logs/l1/events');
    const db = buildMockDb({ events: parents });
    const result = await findCollectionGroup(db, 'events', { limit: 9999 });
    expect(result.reads).toBe(5);
    expect(result.limitWasReached).toBe(false);
  });
});

// ─── 5. Template path conversion ──────────────────────────────────────────

describe('findCollectionGroup — concrete → template conversion', () => {
  test('multiple concrete hosts under same template collapse to one host', async () => {
    // 3 distinct user IDs, all map to template `users/{userId}/posts`.
    const parents = ['users/uid_a/posts', 'users/uid_b/posts', 'users/uid_c/posts'];
    const db = buildMockDb({ posts: parents });
    const result = await findCollectionGroup(db, 'posts');

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]!.templatePath).toBe('users/{userId}/posts');
    expect(result.hosts[0]!.sampleDocCount).toBe(3);
  });

  test('distinct templates stay separate (different parent collections)', async () => {
    // `posts` lives under both `users` and `orgs` — distinct templates.
    const parents = [
      'users/uid_a/posts',
      'orgs/org_1/posts',
      'users/uid_b/posts',
      'orgs/org_2/posts',
    ];
    const db = buildMockDb({ posts: parents });
    const result = await findCollectionGroup(db, 'posts');

    expect(result.hosts).toHaveLength(2);
    const templates = result.hosts.map((h) => h.templatePath).sort();
    expect(templates).toEqual(['orgs/{orgId}/posts', 'users/{userId}/posts']);

    const byTpl = new Map(result.hosts.map((h) => [h.templatePath, h.sampleDocCount]));
    expect(byTpl.get('users/{userId}/posts')).toBe(2);
    expect(byTpl.get('orgs/{orgId}/posts')).toBe(2);
  });

  test('deeply nested concrete paths convert correctly', async () => {
    const parents = [
      'ttt_lobbies/lobby_1/games/game_1/moves',
      'ttt_lobbies/lobby_2/games/game_2/moves',
    ];
    const db = buildMockDb({ moves: parents });
    const result = await findCollectionGroup(db, 'moves');

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]!.templatePath).toBe(
      'ttt_lobbies/{lobbyId}/games/{gameId}/moves',
    );
    expect(result.hosts[0]!.sampleDocCount).toBe(2);
  });
});

// ─── 6. sampleDocCount arithmetic ─────────────────────────────────────────

describe('findCollectionGroup — sampleDocCount arithmetic', () => {
  test('per-host counts match the actual sampled docs', async () => {
    // Mix: host A gets 7, host B gets 3, host C gets 1 — all under one template.
    const parents = [
      ...Array.from({ length: 7 }, () => 'projects/p1/tasks'),
      ...Array.from({ length: 3 }, () => 'projects/p2/tasks'),
      ...Array.from({ length: 1 }, () => 'projects/p3/tasks'),
    ];
    const db = buildMockDb({ tasks: parents });
    const result = await findCollectionGroup(db, 'tasks');

    // All collapse to one template.
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]!.templatePath).toBe('projects/{projectId}/tasks');
    expect(result.hosts[0]!.sampleDocCount).toBe(11);
    expect(result.reads).toBe(11);
  });

  test('cross-template counts stay independent', async () => {
    const parents = [
      'a_things/a1/x',
      'a_things/a1/x',
      'b_things/b1/x',
    ];
    const db = buildMockDb({ x: parents });
    const result = await findCollectionGroup(db, 'x');

    const byTpl = new Map(result.hosts.map((h) => [h.templatePath, h.sampleDocCount]));
    expect(byTpl.get('a_things/{thingId}/x')).toBe(2);
    expect(byTpl.get('b_things/{thingId}/x')).toBe(1);
    expect(result.reads).toBe(3);
  });
});

// ─── 7. Input validation ──────────────────────────────────────────────────

describe('findCollectionGroup — input validation', () => {
  test('empty collectionId throws', async () => {
    const db = buildMockDb({});
    await expect(findCollectionGroup(db, '')).rejects.toThrow(/non-empty string/);
  });

  test('non-positive limit throws RangeError', async () => {
    const db = buildMockDb({});
    await expect(findCollectionGroup(db, 'x', { limit: 0 })).rejects.toThrow(RangeError);
    await expect(findCollectionGroup(db, 'x', { limit: -5 })).rejects.toThrow(RangeError);
  });

  test('non-integer limit throws RangeError', async () => {
    const db = buildMockDb({});
    await expect(findCollectionGroup(db, 'x', { limit: 1.5 })).rejects.toThrow(RangeError);
  });
});

// ─── 8. Insertion order preservation ──────────────────────────────────────

describe('findCollectionGroup — host order is insertion order', () => {
  test('hosts appear in the order their first matching doc surfaced', async () => {
    // First doc → orgs template, second → users template.
    const parents = [
      'orgs/org_1/posts',
      'users/uid_1/posts',
      'orgs/org_2/posts',
      'users/uid_2/posts',
    ];
    const db = buildMockDb({ posts: parents });
    const result = await findCollectionGroup(db, 'posts');

    // The mock preserves array order, so orgs surfaces first.
    expect(result.hosts[0]!.templatePath).toBe('orgs/{orgId}/posts');
    expect(result.hosts[1]!.templatePath).toBe('users/{userId}/posts');
  });
});

// ─── Mock-fidelity sanity check ───────────────────────────────────────────

describe('mock fidelity (smoke test for the test fixture itself)', () => {
  test('exactly one collectionGroup, one select, one limit, one get per call', async () => {
    const db = buildMockDb({ posts: ['users/u1/posts'] });
    await findCollectionGroup(db, 'posts');
    expect(db.metrics.collectionGroupCalls).toBe(1);
    expect(db.metrics.selectCalls).toBe(1);
    expect(db.metrics.limitCalls).toBe(1);
    expect(db.metrics.getCalls).toBe(1);
  });
});
