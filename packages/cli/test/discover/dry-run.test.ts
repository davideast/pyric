/**
 * Item 5.1 — `dryRun: true` informational-only cost preview.
 *
 * Locked behavior (per Item 5 revision 2026-05-03):
 *   - Issues exactly one RPC: root `db.listCollections()`.
 *   - No documents read, no per-doc listCollections, no sampling.
 *   - Returns a heuristic projection in `dryRunCostEstimate`.
 *   - `complete: true`, `continuation: undefined` — no resume pattern.
 *
 * Rationale (the contract that motivates these tests): an agent reading
 * `dryRun: true` reasonably expects no real crawl happened. Doing
 * deeper work under that flag would let the agent make decisions on
 * data it didn't realize it paid for.
 *
 * This file pins:
 *   1. The single-RPC safety contract (zero non-root work).
 *   2. The result shape (no continuation, no schemas, no discovered map).
 *   3. The projection arithmetic — both the listOps and readOps formulas.
 *   4. `rootFilter` narrows the projection.
 *   5. Empty database → projection of zero.
 *   6. Continuation passed with dryRun → structured DRYRUN_NO_CONTINUATION error.
 *   7. `dryRunSubtreeMultiplier` and `maxSamples` honored in projection.
 */

import { describe, expect, test } from 'bun:test';
import { crawl } from '../../src/discover/crawler.js';
import { buildMockFirestore, type DocSpec, type TreeSpec } from './helpers/mock-firestore.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** Tree with several roots, docs, and subcollections. Used to confirm
 *  dryRun does NOT walk past the root layer. */
function richTree(): TreeSpec {
  const docsWithSubs: DocSpec[] = [
    {
      id: 'd0',
      fields: { x: { stringValue: 'v' } },
      subs: {
        sub0: [{ id: 'a', fields: { y: { stringValue: 'v' } } }],
        sub1: [{ id: 'b', fields: { z: { stringValue: 'v' } } }],
      },
    },
    { id: 'd1', fields: { x: { stringValue: 'v' } } },
  ];
  return {
    coll0: docsWithSubs,
    coll1: [{ id: 'd0', fields: { y: { stringValue: 'v' } } }],
    coll2: [{ id: 'd0', fields: { z: { stringValue: 'v' } } }],
  };
}

// ─── 1. Single-RPC safety contract ────────────────────────────────────────

describe('dryRun safety contract: only root listCollections runs', () => {
  test('issues exactly 1 listCollections call, zero listDocuments, zero gets', async () => {
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, { dryRun: true });

    expect(db.metrics.listCollectionsCalls).toBe(1);
    expect(db.metrics.listDocumentsCalls).toBe(0);
    expect(db.metrics.getCalls).toBe(0);

    expect(result.complete).toBe(true);
    expect(result.continuation).toBeUndefined();
    expect(result.dryRunCostEstimate).toBeDefined();
  });

  test('no real crawl side effects: empty discovered, empty schemas', async () => {
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, { dryRun: true });

    expect(result.discovered.size).toBe(0);
    expect(result.finalizedSchemas.size).toBe(0);
    expect(result.readOps).toBe(0);
    expect(result.listOps).toBe(1); // the one root call
  });

  test('emits collection_discovered for each root, depth 0', async () => {
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, { dryRun: true });

    const events = result.events.filter((e) => e.kind === 'collection_discovered');
    expect(events).toHaveLength(3);
    for (const ev of events) {
      if (ev.kind === 'collection_discovered') {
        expect(ev.depth).toBe(0);
      }
    }
  });
});

// ─── 2. Projection arithmetic ─────────────────────────────────────────────

describe('dryRunCostEstimate projection formulas', () => {
  test('estimatedListOps = 1 + rootCount × subtreeMultiplier (defaults)', async () => {
    // 3 roots × default multiplier 3 = 9, +1 root call = 10.
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, { dryRun: true });
    const est = result.dryRunCostEstimate!;
    expect(est.rootCollectionCount).toBe(3);
    expect(est.subtreeMultiplier).toBe(3);
    expect(est.estimatedListOps).toBe(1 + 3 * 3);
  });

  test('estimatedReadOps = rootCount × subtreeMultiplier × maxSamples (defaults)', async () => {
    // 3 roots × multiplier 3 × maxSamples 50 (default) = 450.
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, { dryRun: true });
    const est = result.dryRunCostEstimate!;
    expect(est.maxSamples).toBe(50);
    expect(est.estimatedReadOps).toBe(3 * 3 * 50);
  });

  test('honors custom maxSamples in projection', async () => {
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, { dryRun: true, maxSamples: 10 });
    const est = result.dryRunCostEstimate!;
    expect(est.maxSamples).toBe(10);
    expect(est.estimatedReadOps).toBe(3 * 3 * 10);
  });

  test('honors custom dryRunSubtreeMultiplier in projection', async () => {
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, { dryRun: true, dryRunSubtreeMultiplier: 5 });
    const est = result.dryRunCostEstimate!;
    expect(est.subtreeMultiplier).toBe(5);
    expect(est.estimatedListOps).toBe(1 + 3 * 5);
    expect(est.estimatedReadOps).toBe(3 * 5 * 50);
  });

  test('rootCollectionIds lists actual discovered root names', async () => {
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, { dryRun: true });
    const est = result.dryRunCostEstimate!;
    expect(est.rootCollectionIds.sort()).toEqual(['coll0', 'coll1', 'coll2']);
  });
});

// ─── 3. rootFilter integration ────────────────────────────────────────────

describe('rootFilter narrows the projection', () => {
  test('filtered roots reflected in count and projection', async () => {
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, {
      dryRun: true,
      rootFilter: (id) => id === 'coll0',
    });
    const est = result.dryRunCostEstimate!;

    expect(est.rootCollectionCount).toBe(1);
    expect(est.rootCollectionIds).toEqual(['coll0']);
    expect(est.estimatedListOps).toBe(1 + 1 * 3); // 4
    expect(est.estimatedReadOps).toBe(1 * 3 * 50); // 150

    // Still only one RPC issued — the root listCollections is unfiltered;
    // filtering happens client-side after the call.
    expect(db.metrics.listCollectionsCalls).toBe(1);
  });

  test('filter that matches nothing → zero projection but still 1 RPC', async () => {
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, {
      dryRun: true,
      rootFilter: () => false,
    });
    const est = result.dryRunCostEstimate!;

    expect(est.rootCollectionCount).toBe(0);
    expect(est.rootCollectionIds).toEqual([]);
    expect(est.estimatedListOps).toBe(1); // just the root call
    expect(est.estimatedReadOps).toBe(0);
    expect(db.metrics.listCollectionsCalls).toBe(1);
  });
});

// ─── 4. Empty database ────────────────────────────────────────────────────

describe('empty database', () => {
  test('zero roots → zero projection, still 1 RPC', async () => {
    const db = buildMockFirestore({});
    const result = await crawl(db, { dryRun: true });
    const est = result.dryRunCostEstimate!;

    expect(est.rootCollectionCount).toBe(0);
    expect(est.estimatedListOps).toBe(1);
    expect(est.estimatedReadOps).toBe(0);
    expect(db.metrics.listCollectionsCalls).toBe(1);
    expect(result.complete).toBe(true);
  });
});

// ─── 5. Continuation incompatibility ──────────────────────────────────────

describe('dryRun rejects continuation tokens', () => {
  test('passing continuation with dryRun → DRYRUN_NO_CONTINUATION error', async () => {
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, { dryRun: true, continuation: 'disc_anything' });

    expect(result.complete).toBe(true);
    expect(result.dryRunCostEstimate).toBeUndefined();
    expect(result.events).toHaveLength(1);
    const ev = result.events[0]!;
    expect(ev.kind).toBe('error');
    if (ev.kind === 'error') {
      expect(ev.code).toBe('DRYRUN_NO_CONTINUATION');
    }
    // Refused before issuing any RPC.
    expect(db.metrics.listCollectionsCalls).toBe(0);
  });
});

// ─── 6. dryRun: false (default) is unchanged ──────────────────────────────

describe('dryRun: false / omitted runs a real crawl (regression guard)', () => {
  test('default behavior unchanged — full crawl produces schemas', async () => {
    const db = buildMockFirestore(richTree());
    const result = await crawl(db, {});

    expect(result.dryRunCostEstimate).toBeUndefined();
    expect(result.finalizedSchemas.size).toBeGreaterThan(0);
    // We did real work — multiple RPCs.
    expect(db.metrics.listDocumentsCalls).toBeGreaterThan(0);
    expect(db.metrics.getCalls).toBeGreaterThan(0);
  });

  test('explicit dryRun: false matches omitted', async () => {
    const dbA = buildMockFirestore(richTree());
    const dbB = buildMockFirestore(richTree());
    const a = await crawl(dbA, { dryRun: false });
    const b = await crawl(dbB, {});
    expect(a.dryRunCostEstimate).toBeUndefined();
    expect(b.dryRunCostEstimate).toBeUndefined();
    expect([...a.finalizedSchemas.keys()].sort()).toEqual(
      [...b.finalizedSchemas.keys()].sort(),
    );
  });
});
