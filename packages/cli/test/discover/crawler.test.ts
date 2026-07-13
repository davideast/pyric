/**
 * Unit tests for the BFS-layer crawler skeleton (Item 2.2).
 *
 * Uses a structural Firestore mock so no firebase-admin dependency is needed.
 * Covers:
 *   - layer 0 enumeration of root collections + rootFilter
 *   - per-doc subcollection fan-out into layer N+1
 *   - templatePath inference (the cross-reference key with rules)
 *   - depth tagging on `collection_discovered` events
 *   - collapse of concrete sibling paths under one templatePath
 *   - bounded concurrency cap honored across layers
 *   - listOps count matches RPC fan-out (drives cost reporting)
 *   - maxDepth runaway guard
 *
 * Item 2.3 will add doc-sampling tests; Item 2.4 adds permission-error
 * tests. This file deliberately stays scoped to structure discovery.
 */

import { describe, expect, test } from 'bun:test';
import {
  crawl,
  crawlStructure,
  inferTemplateVariable,
  toTemplatePath,
} from '../../src/discover/crawler.js';
import type {
  CrawlerCollectionRef,
  CrawlerDocumentRef,
  CrawlerFirestore,
  WireDocumentSnapshot,
} from '../../src/discover/firestore-source.js';
import { buildMockFirestore, type TreeSpec } from './helpers/mock-firestore.js';

// ─── inferTemplateVariable ────────────────────────────────────────────────

describe('inferTemplateVariable', () => {
  test('strips trailing s for simple plurals', () => {
    expect(inferTemplateVariable('users')).toBe('userId');
    expect(inferTemplateVariable('posts')).toBe('postId');
  });
  test('handles -ies plural', () => {
    expect(inferTemplateVariable('lobbies')).toBe('lobbyId');
    expect(inferTemplateVariable('countries')).toBe('countryId');
  });
  test('handles -ses plural', () => {
    expect(inferTemplateVariable('classes')).toBe('classId');
  });
  test('strips snake-case namespace prefix', () => {
    expect(inferTemplateVariable('ttt_lobbies')).toBe('lobbyId');
    expect(inferTemplateVariable('ttt_games')).toBe('gameId');
  });
  test('singular collection ID stays as-is', () => {
    expect(inferTemplateVariable('inbox')).toBe('inboxId');
  });
  test('short word: not over-stripped', () => {
    expect(inferTemplateVariable('us')).toBe('usId');
  });
});

// ─── toTemplatePath ───────────────────────────────────────────────────────

describe('toTemplatePath', () => {
  test('top-level collection: no transformation needed', () => {
    expect(toTemplatePath('users')).toBe('users');
  });
  test('one level deep: doc segment becomes template var', () => {
    expect(toTemplatePath('users/uid_1/posts')).toBe('users/{userId}/posts');
  });
  test('two levels deep: each doc segment templated independently', () => {
    expect(toTemplatePath('ttt_lobbies/abc/games/g1/moves')).toBe(
      'ttt_lobbies/{lobbyId}/games/{gameId}/moves',
    );
  });
  test('rejects even-length path (concrete doc, not collection)', () => {
    expect(() => toTemplatePath('users/uid_1')).toThrow();
  });
});

// ─── crawlStructure — basics ──────────────────────────────────────────────

describe('crawlStructure — basics', () => {
  test('layer 0: enumerates root collections, emits collection_discovered', async () => {
    const db = buildMockFirestore({
      users: [],
      posts: [],
    });
    const result = await crawlStructure(db);
    expect(result.discovered.size).toBe(2);
    expect(result.discovered.has('users')).toBe(true);
    expect(result.discovered.has('posts')).toBe(true);
    const events = result.events.filter((e) => e.kind === 'collection_discovered');
    expect(events.map((e) => (e.kind === 'collection_discovered' ? e.templatePath : ''))).toContain(
      'users',
    );
  });

  test('rootFilter scopes layer 0 enumeration', async () => {
    const db = buildMockFirestore({
      keep_a: [],
      keep_b: [],
      drop_c: [],
    });
    const result = await crawlStructure(db, {
      rootFilter: (id) => id.startsWith('keep_'),
    });
    expect(result.discovered.size).toBe(2);
    expect(result.discovered.has('drop_c')).toBe(false);
  });

  test('depth 1: per-doc subcollection fan-out into layer 1', async () => {
    const db = buildMockFirestore({
      users: [
        { id: 'u1', subs: { posts: [{ id: 'p1' }] } },
        { id: 'u2', subs: { posts: [{ id: 'p2' }] } },
      ],
    });
    const result = await crawlStructure(db);
    // Both users/{uid}/posts paths collapse to one templatePath
    expect(result.discovered.has('users')).toBe(true);
    expect(result.discovered.has('users/{userId}/posts')).toBe(true);
    expect(result.discovered.size).toBe(2);
    // The collapsed entry retains both concrete refs
    const posts = result.discovered.get('users/{userId}/posts')!;
    expect(posts.refs).toHaveLength(2);
    expect(posts.refs.map((r) => r.path).sort()).toEqual(['users/u1/posts', 'users/u2/posts']);
  });

  test('depth 2: deep tree discovered correctly', async () => {
    const db = buildMockFirestore({
      orgs: [
        {
          id: 'o1',
          subs: {
            teams: [{ id: 't1', subs: { members: [{ id: 'm1' }] } }],
          },
        },
      ],
    });
    const result = await crawlStructure(db);
    expect(Array.from(result.discovered.keys()).sort()).toEqual([
      'orgs',
      'orgs/{orgId}/teams',
      'orgs/{orgId}/teams/{teamId}/members',
    ]);
    // Depth tags
    expect(result.discovered.get('orgs')!.depth).toBe(0);
    expect(result.discovered.get('orgs/{orgId}/teams')!.depth).toBe(1);
    expect(result.discovered.get('orgs/{orgId}/teams/{teamId}/members')!.depth).toBe(2);
  });

  test('events include parentPath for non-root collections', async () => {
    const db = buildMockFirestore({
      users: [{ id: 'u1', subs: { posts: [{ id: 'p1' }] } }],
    });
    const result = await crawlStructure(db);
    const subEvent = result.events.find(
      (e) => e.kind === 'collection_discovered' && e.templatePath === 'users/{userId}/posts',
    );
    expect(subEvent?.kind).toBe('collection_discovered');
    if (subEvent?.kind === 'collection_discovered') {
      expect(subEvent.parentPath).toBe('users/u1');
      expect(subEvent.depth).toBe(1);
    }
  });

  test('collection_discovered emitted exactly once per templatePath', async () => {
    const db = buildMockFirestore({
      users: [
        { id: 'u1', subs: { posts: [{ id: 'p1' }] } },
        { id: 'u2', subs: { posts: [{ id: 'p2' }] } },
        { id: 'u3', subs: { posts: [{ id: 'p3' }] } },
      ],
    });
    const result = await crawlStructure(db);
    const postsEvents = result.events.filter(
      (e) =>
        e.kind === 'collection_discovered' && e.templatePath === 'users/{userId}/posts',
    );
    expect(postsEvents).toHaveLength(1);
  });
});

// ─── crawlStructure — concurrency + cost ──────────────────────────────────

describe('crawlStructure — concurrency + cost', () => {
  test('honors maxConcurrency across layers', async () => {
    // 20 sibling root collections, each with 5 docs → layer 1 has 100 doc
    // listCollections calls. With latency, peak in-flight should respect cap.
    const spec: TreeSpec = {};
    for (let i = 0; i < 20; i++) {
      spec[`coll_${i}`] = Array.from({ length: 5 }, (_, j) => ({ id: `d${j}` }));
    }
    const db = buildMockFirestore(spec, { rpcLatencyMs: 5 });
    await crawlStructure(db, { maxConcurrency: 4 });
    expect(db.metrics.peakInFlight).toBeLessThanOrEqual(4);
  });

  test('listOps reflects every list RPC issued', async () => {
    // 1 (root) + 2 (listDocs of two top colls) + 4 (listColls per doc) = 7
    const db = buildMockFirestore({
      a: [{ id: 'd1' }, { id: 'd2' }],
      b: [{ id: 'd3' }, { id: 'd4' }],
    });
    const result = await crawlStructure(db);
    expect(result.listOps).toBe(7);
    expect(db.metrics.listCollectionsCalls + db.metrics.listDocumentsCalls).toBe(7);
  });
});

// ─── crawlStructure — runaway guard ───────────────────────────────────────

describe('crawlStructure — maxDepth', () => {
  test('stops after maxDepth layers even if tree continues', async () => {
    // Tree of depth 3, but cap at 1.
    const db = buildMockFirestore({
      a: [
        {
          id: 'd1',
          subs: {
            b: [{ id: 'd2', subs: { c: [{ id: 'd3' }] } }],
          },
        },
      ],
    });
    const result = await crawlStructure(db, { maxDepth: 1 });
    expect(result.discovered.has('a')).toBe(true);
    expect(result.discovered.has('a/{aId}/b')).toBe(true);
    expect(result.discovered.has('a/{aId}/b/{bId}/c')).toBe(false);
  });
});

// ─── crawl (Item 2.3 — sampling + merge integration) ──────────────────────

// ─── crawl (Item 2.4 — permission-error resilience per 0.E) ──────────────

/**
 * Construct a gRPC-style permission error. firebase-admin throws errors
 * with `code` as a numeric gRPC status (PERMISSION_DENIED=7) on the real
 * SDK; we mirror that here.
 */
function permissionError(message = 'permission denied'): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = 7;
  return err;
}

function unavailableError(message = 'unavailable'): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = 14;
  return err;
}

describe('crawl — permission-error resilience (0.E)', () => {
  test('per-collection listDocuments PERMISSION_DENIED → error event, crawl continues', async () => {
    const goodColl: CrawlerCollectionRef = {
      id: 'good',
      path: 'good',
      async listDocuments() {
        return [
          {
            id: 'd1',
            path: 'good/d1',
            async listCollections() {
              return [];
            },
            async get() {
              return { _fieldsProto: { v: { stringValue: 'ok' } }, ref: { path: 'good/d1' } };
            },
          },
        ];
      },
    };
    const badColl: CrawlerCollectionRef = {
      id: 'bad',
      path: 'bad',
      async listDocuments() {
        throw permissionError('cannot list bad/');
      },
    };
    const db: CrawlerFirestore = {
      async listCollections() {
        return [goodColl, badColl];
      },
    };
    const result = await crawl(db);
    const errors = result.events.filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0]?.kind === 'error') {
      expect(errors[0].templatePath).toBe('bad');
      expect(errors[0].code).toBe('PERMISSION_DENIED');
    }
    // Good collection still got sampled
    expect(result.finalizedSchemas.get('good')!.schema.samplesSeen).toBe(1);
    // Bad collection appears but with empty schema
    expect(result.finalizedSchemas.get('bad')!.schema.samplesSeen).toBe(0);
  });

  test('per-doc listCollections error attributes to parent templatePath', async () => {
    const db: CrawlerFirestore = {
      async listCollections() {
        return [
          {
            id: 'users',
            path: 'users',
            async listDocuments() {
              return [
                {
                  id: 'u1',
                  path: 'users/u1',
                  async listCollections() {
                    throw permissionError();
                  },
                  async get() {
                    return { _fieldsProto: { v: { stringValue: 'ok' } }, ref: { path: 'users/u1' } };
                  },
                },
              ];
            },
          },
        ];
      },
    };
    const result = await crawl(db);
    const errors = result.events.filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0]?.kind === 'error') {
      expect(errors[0].templatePath).toBe('users');
    }
  });

  test('UNAVAILABLE (transient) treated same as PERMISSION_DENIED', async () => {
    const db: CrawlerFirestore = {
      async listCollections() {
        return [
          {
            id: 'flaky',
            path: 'flaky',
            async listDocuments() {
              throw unavailableError();
            },
          },
        ];
      },
    };
    const result = await crawl(db);
    const errors = result.events.filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0]?.kind === 'error') {
      expect(errors[0].code).toBe('UNAVAILABLE');
    }
  });

  test('non-retryable errors (e.g. NOT_FOUND) re-throw — fail loud per 0.A spirit', async () => {
    const notFound = new Error('not found') as Error & { code: number };
    notFound.code = 5; // NOT_FOUND — not in retryable set
    const db: CrawlerFirestore = {
      async listCollections() {
        throw notFound;
      },
    };
    await expect(crawl(db)).rejects.toThrow('not found');
  });

  test('per-doc .get() errors count toward maxErrorsPerCollection budget', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      path: `coll/d${i}`,
      async listCollections() {
        return [];
      },
      async get(): Promise<WireDocumentSnapshot> {
        // First 5 fail, rest succeed — but budget kicks in first.
        if (i < 5) throw permissionError(`doc ${i} denied`);
        return { _fieldsProto: { v: { stringValue: `v${i}` } }, ref: { path: `coll/d${i}` } };
      },
    }));
    const db: CrawlerFirestore = {
      async listCollections() {
        return [
          {
            id: 'coll',
            path: 'coll',
            async listDocuments() {
              return docs;
            },
          },
        ];
      },
    };
    const result = await crawl(db, { maxErrorsPerCollection: 3, maxConcurrency: 1 });
    const errors = result.events.filter((e) => e.kind === 'error');
    // Exactly 3 errors recorded before budget tripped
    expect(errors).toHaveLength(3);
    // samplingComplete flips to sampling_open
    expect(result.finalizedSchemas.get('coll')!.samplingComplete).toBe('sampling_open');
  });

  test('error budget tripping does not halt OTHER templatePaths', async () => {
    const failingDoc: CrawlerDocumentRef = {
      id: 'd1',
      path: 'failing/d1',
      async listCollections() {
        return [];
      },
      async get() {
        throw permissionError();
      },
    };
    const db: CrawlerFirestore = {
      async listCollections() {
        return [
          {
            id: 'failing',
            path: 'failing',
            async listDocuments() {
              return [failingDoc];
            },
          },
          {
            id: 'working',
            path: 'working',
            async listDocuments() {
              return [
                {
                  id: 'w1',
                  path: 'working/w1',
                  async listCollections() {
                    return [];
                  },
                  async get() {
                    return { _fieldsProto: { v: { stringValue: 'ok' } }, ref: { path: 'working/w1' } };
                  },
                },
              ];
            },
          },
        ];
      },
    };
    const result = await crawl(db, { maxErrorsPerCollection: 1 });
    expect(result.finalizedSchemas.get('failing')!.samplingComplete).toBe('sampling_open');
    expect(result.finalizedSchemas.get('working')!.samplingComplete).toBe('converged_via_exhausted');
    expect(result.finalizedSchemas.get('working')!.schema.samplesSeen).toBe(1);
  });

  test('root listCollections error → empty crawl + single root error event', async () => {
    const db: CrawlerFirestore = {
      async listCollections() {
        throw permissionError('no root list');
      },
    };
    const result = await crawl(db);
    const errors = result.events.filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0]?.kind === 'error') {
      expect(errors[0].templatePath).toBe('');
    }
    expect(result.discovered.size).toBe(0);
    expect(result.finalizedSchemas.size).toBe(0);
  });
});

describe('crawl — sampling + merge', () => {
  test('reads docs, builds field schema, emits schema_updated', async () => {
    const db = buildMockFirestore({
      users: [
        { id: 'u1', fields: { name: { stringValue: 'alice' }, age: { integerValue: '30' } } },
        { id: 'u2', fields: { name: { stringValue: 'bob' }, age: { integerValue: '25' } } },
      ],
    });
    const result = await crawl(db);
    const usersSchema = result.finalizedSchemas.get('users');
    expect(usersSchema).toBeDefined();
    expect(usersSchema!.schema.samplesSeen).toBe(2);
    expect(Object.keys(usersSchema!.schema.fields).sort()).toEqual(['age', 'name']);
    expect(usersSchema!.schema.fields.name!.types).toEqual([
      { kind: 'scalar', type: 'string' },
    ]);
    // schema_updated emitted at least once for the users collection
    const updates = result.events.filter(
      (e) => e.kind === 'schema_updated' && e.templatePath === 'users',
    );
    expect(updates.length).toBeGreaterThan(0);
  });

  test('exhausting available docs → samplingComplete = converged_via_exhausted', async () => {
    const db = buildMockFirestore({
      tiny: [
        { id: 'd1', fields: { x: { stringValue: 'a' } } },
        { id: 'd2', fields: { x: { stringValue: 'b' } } },
        { id: 'd3', fields: { x: { stringValue: 'c' } } },
      ],
    });
    const result = await crawl(db, { maxSamples: 50 });
    const cs = result.finalizedSchemas.get('tiny')!;
    expect(cs.samplingComplete).toBe('converged_via_exhausted');
    expect(cs.schema.samplesSeen).toBe(3);
  });

  test('hitting maxSamples → samplingComplete = converged_via_max', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      fields: { x: { stringValue: `v${i}` } },
    }));
    const db = buildMockFirestore({ many: docs });
    const result = await crawl(db, { maxSamples: 4 });
    const cs = result.finalizedSchemas.get('many')!;
    expect(cs.samplingComplete).toBe('converged_via_max');
    expect(cs.schema.samplesSeen).toBe(4);
    expect(result.readOps).toBe(4);
  });

  test('emits sampling_complete event per templatePath', async () => {
    const db = buildMockFirestore({
      a: [{ id: 'd1', fields: { x: { stringValue: 'v' } } }],
      b: [{ id: 'd1', fields: { y: { integerValue: '1' } } }],
    });
    const result = await crawl(db);
    const sc = result.events.filter((e) => e.kind === 'sampling_complete');
    expect(sc).toHaveLength(2);
    const paths = sc.map((e) => (e.kind === 'sampling_complete' ? e.templatePath : '')).sort();
    expect(paths).toEqual(['a', 'b']);
  });

  test('ghost-parent docs (no _fieldsProto) are skipped, subcollections still discovered', async () => {
    const db = buildMockFirestore({
      missing_parents: [
        // No `fields` → ghost parent. Has subcollections.
        { id: 'ghost1', subs: { children: [{ id: 'c1', fields: { v: { stringValue: 'x' } } }] } },
      ],
    });
    const result = await crawl(db);
    // Parent collection discovered but its schema is empty (no real docs)
    const parent = result.finalizedSchemas.get('missing_parents')!;
    expect(parent.schema.samplesSeen).toBe(0);
    // Child collection discovered AND populated
    const child = result.finalizedSchemas.get('missing_parents/{parentId}/children')!;
    expect(child).toBeDefined();
    expect(child.schema.samplesSeen).toBe(1);
    expect(Object.keys(child.schema.fields)).toEqual(['v']);
  });

  test('reserved field names surface via descriptor.reservedReason', async () => {
    const db = buildMockFirestore({
      misc: [
        {
          id: 'd1',
          fields: {
            normal: { stringValue: 'ok' },
            'user.id': { stringValue: 'dotted' },
            __name__: { stringValue: 'reserved' },
          },
        },
      ],
    });
    const result = await crawl(db);
    const cs = result.finalizedSchemas.get('misc')!;
    expect(cs.schema.fields.normal!.reservedReason).toBeUndefined();
    expect(cs.schema.fields['user.id']!.reservedReason).toBe('dotted_field_name');
    expect(cs.schema.fields.__name__!.reservedReason).toBe('firestore_reserved_name');
  });

  test('subcollectionTemplatePaths populated for direct children only', async () => {
    const db = buildMockFirestore({
      orgs: [
        {
          id: 'o1',
          fields: { name: { stringValue: 'acme' } },
          subs: {
            teams: [
              {
                id: 't1',
                fields: { name: { stringValue: 'eng' } },
                subs: { members: [{ id: 'm1', fields: { role: { stringValue: 'lead' } } }] },
              },
            ],
          },
        },
      ],
    });
    const result = await crawl(db);
    expect(result.finalizedSchemas.get('orgs')!.subcollectionTemplatePaths).toEqual([
      'orgs/{orgId}/teams',
    ]);
    expect(result.finalizedSchemas.get('orgs/{orgId}/teams')!.subcollectionTemplatePaths).toEqual([
      'orgs/{orgId}/teams/{teamId}/members',
    ]);
    expect(
      result.finalizedSchemas.get('orgs/{orgId}/teams/{teamId}/members')!
        .subcollectionTemplatePaths,
    ).toEqual([]);
  });

  test('readOps reflects only successful .get() calls', async () => {
    const db = buildMockFirestore({
      a: [
        { id: 'd1', fields: { v: { stringValue: 'x' } } },
        { id: 'd2', fields: { v: { stringValue: 'y' } } },
      ],
    });
    const result = await crawl(db);
    expect(result.readOps).toBe(2);
    expect(db.metrics.getCalls).toBe(2);
  });

  test('multiple concrete instances of one templatePath sample across both', async () => {
    const db = buildMockFirestore({
      users: [
        { id: 'u1', subs: { posts: [{ id: 'p1', fields: { title: { stringValue: 'one' } } }] } },
        { id: 'u2', subs: { posts: [{ id: 'p2', fields: { title: { stringValue: 'two' } } }] } },
      ],
    });
    const result = await crawl(db);
    const posts = result.finalizedSchemas.get('users/{userId}/posts')!;
    expect(posts.schema.samplesSeen).toBe(2);
  });
});

// ─── crawl (Item 3.1 — adaptive sampling via stopOnStable) ────────────────

describe('crawl — stopOnStable adaptive early-exit', () => {
  test('homogeneous stream → converged_via_stable, declaredAt matches merge semantic', async () => {
    // 10 identical docs. stopOnStable=3 means after the 1st doc introduces
    // the schema, 3 consecutive no-change merges trigger early-exit.
    // Per `runConvergence` semantic, declaredAt = merged-doc index where
    // consecutiveStable reaches the threshold. So:
    //   d0 → change, consecutiveStable=0
    //   d1 → no change, consecutiveStable=1
    //   d2 → no change, consecutiveStable=2
    //   d3 → no change, consecutiveStable=3 → declared at samplesSeen-1 = 3
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: `d${i}`,
      fields: { x: { stringValue: 'same' } },
    }));
    const db = buildMockFirestore({ stable: docs });
    const result = await crawl(db, { stopOnStable: 3, maxSamples: 50 });
    const cs = result.finalizedSchemas.get('stable')!;
    expect(cs.samplingComplete).toBe('converged_via_stable');
    expect(cs.declaredAt).toBe(3);
    expect(cs.schema.samplesSeen).toBe(4); // d0..d3 merged
  });

  test('chunked fetching: early-exit saves reads vs full sweep', async () => {
    // 100 stable docs with stopOnStable=3. chunkSize=3, so we fetch chunks
    // [d0,d1,d2] then [d3,d4,d5]. Convergence fires on d3, the rest of the
    // chunk is wasted but we never fetch chunks 3+. Worst-case wasted reads
    // = stopOnStable - 1 = 2. So readOps should be 6, NOT 100.
    const docs = Array.from({ length: 100 }, (_, i) => ({
      id: `d${i}`,
      fields: { x: { stringValue: 'same' } },
    }));
    const db = buildMockFirestore({ stable: docs });
    const result = await crawl(db, { stopOnStable: 3, maxSamples: 100 });
    expect(result.readOps).toBe(6);
    expect(result.finalizedSchemas.get('stable')!.samplingComplete).toBe('converged_via_stable');
  });

  test('diverging stream (every doc adds a new field) → never declares', async () => {
    // Each doc introduces a NEW field, so consecutiveStable never reaches
    // stopOnStable. Sampling exhausts the available docs.
    const docs = [
      { id: 'd0', fields: { a: { stringValue: 'v' } } },
      { id: 'd1', fields: { b: { stringValue: 'v' } } },
      { id: 'd2', fields: { c: { stringValue: 'v' } } },
      { id: 'd3', fields: { d: { stringValue: 'v' } } },
      { id: 'd4', fields: { e: { stringValue: 'v' } } },
    ];
    const db = buildMockFirestore({ noisy: docs });
    const result = await crawl(db, { stopOnStable: 3, maxSamples: 50 });
    const cs = result.finalizedSchemas.get('noisy')!;
    expect(cs.samplingComplete).toBe('converged_via_exhausted');
    expect(cs.declaredAt).toBeNull();
    expect(cs.schema.samplesSeen).toBe(5);
  });

  test('stopOnStable disabled (set above maxSamples) → maxSamples governs', async () => {
    // stopOnStable=100, maxSamples=5: cap fires before stable-streak ever
    // could. Even with all-stable docs, samplingComplete is converged_via_max.
    const docs = Array.from({ length: 20 }, (_, i) => ({
      id: `d${i}`,
      fields: { x: { stringValue: 'same' } },
    }));
    const db = buildMockFirestore({ capped: docs });
    const result = await crawl(db, { stopOnStable: 100, maxSamples: 5 });
    const cs = result.finalizedSchemas.get('capped')!;
    expect(cs.samplingComplete).toBe('converged_via_max');
    expect(cs.declaredAt).toBeNull();
    expect(cs.schema.samplesSeen).toBe(5);
  });

  test('change late in the stream resets consecutive-stable counter', async () => {
    // d0: introduces {x}. d1,d2,d3: no change (counter goes 1,2,3) — but
    // wait, that would already trigger at stopOnStable=3. Use stopOnStable=4
    // and inject a change at d3 to reset the counter, forcing the stream
    // to continue past where it would otherwise have declared.
    const docs = [
      { id: 'd0', fields: { x: { stringValue: 'v' } } },
      { id: 'd1', fields: { x: { stringValue: 'v' } } },
      { id: 'd2', fields: { x: { stringValue: 'v' } } },
      // Reset: introduces a new field
      { id: 'd3', fields: { x: { stringValue: 'v' }, y: { stringValue: 'w' } } },
      { id: 'd4', fields: { x: { stringValue: 'v' }, y: { stringValue: 'w' } } },
      { id: 'd5', fields: { x: { stringValue: 'v' }, y: { stringValue: 'w' } } },
      { id: 'd6', fields: { x: { stringValue: 'v' }, y: { stringValue: 'w' } } },
      { id: 'd7', fields: { x: { stringValue: 'v' }, y: { stringValue: 'w' } } },
    ];
    const db = buildMockFirestore({ wobbly: docs });
    const result = await crawl(db, { stopOnStable: 4, maxSamples: 50 });
    const cs = result.finalizedSchemas.get('wobbly')!;
    expect(cs.samplingComplete).toBe('converged_via_stable');
    // After d3 reset, d4..d7 are 4 stable in a row → declares at d7's
    // merged-doc index = 7
    expect(cs.declaredAt).toBe(7);
  });

  test('default stopOnStable applies when option omitted', async () => {
    // 20 stable docs; default stopOnStable=8 should fire at index 8.
    const docs = Array.from({ length: 20 }, (_, i) => ({
      id: `d${i}`,
      fields: { x: { stringValue: 'same' } },
    }));
    const db = buildMockFirestore({ stable: docs });
    const result = await crawl(db); // no stopOnStable override
    const cs = result.finalizedSchemas.get('stable')!;
    expect(cs.samplingComplete).toBe('converged_via_stable');
    expect(cs.declaredAt).toBe(8);
  });
});
