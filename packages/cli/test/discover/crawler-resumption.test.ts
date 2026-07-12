/**
 * Item 4.2 — Crawler resumption integration.
 *
 * The crawler accepts an optional `SessionStore<PersistedCrawlState>`. When
 * supplied, after every BFS layer (structure phase) and every templatePath
 * (sampling phase) the crawler measures `JSON.stringify(state).length` and
 * pauses if it exceeds `maxBatchBytes`, returning a `continuation` token.
 *
 * This file pins:
 *   1. Single-call mode (no SessionStore) is unchanged — every existing
 *      test in crawler.test.ts already covers this; we add a regression
 *      check that passing a SessionStore *without* triggering a pause
 *      yields the same finalizedSchemas.
 *   2. Byte-for-byte equivalence: a forced multi-batch crawl (small
 *      maxBatchBytes) produces the same finalizedSchemas as a single-call
 *      crawl on the same fixture.
 *   3. The agent loop terminates: drain the continuation chain to
 *      completion and verify `complete: true` arrives within a bounded
 *      number of batches.
 *   4. Cumulative counters: `listOps` and `readOps` accumulate across
 *      batches (per the Item 4.2 design — agents don't bookkeep).
 *   5. Per-batch events: events array is per-batch, not cumulative
 *      (also per design — agents accumulate themselves).
 *   6. Structured continuation errors:
 *        - SESSION_MALFORMED_TOKEN — bogus token string
 *        - SESSION_EXPIRED         — fast-forward `now()` past TTL
 *        - SESSION_EVICTED         — fill to maxSessions then bump
 *        - NO_SESSION_STORE        — continuation passed without store
 *   7. Pause boundaries fire at the documented points:
 *        - structure phase: after a layer, before sampling starts
 *        - sampling phase:  between templatePaths
 */

import { describe, expect, test } from 'bun:test';
import {
  crawl,
  type PersistedCrawlState,
} from '../../src/discover/crawler.js';
import { SessionStore } from '../../src/discover/session.js';
import { buildMockFirestore, type DocSpec, type TreeSpec } from './helpers/mock-firestore.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** Build a wide tree: many root collections, each with many docs, each
 *  with a couple of subcollections. Drives JSON state size up so the
 *  small-maxBatchBytes pause check fires repeatedly. */
function wideTree(rootCount: number, docsPerColl: number, subCount: number): TreeSpec {
  const spec: TreeSpec = {};
  for (let r = 0; r < rootCount; r++) {
    const docs: DocSpec[] = [];
    for (let d = 0; d < docsPerColl; d++) {
      const subs: TreeSpec = {};
      for (let s = 0; s < subCount; s++) {
        subs[`sub${s}`] = [
          { id: 'a', fields: { x: { stringValue: 'v' } } },
          { id: 'b', fields: { x: { stringValue: 'v' } } },
        ];
      }
      docs.push({ id: `d${d}`, fields: { x: { stringValue: 'v' } }, subs });
    }
    spec[`coll${r}`] = docs;
  }
  return spec;
}

/** Drive the agent loop: keep calling `crawl()` with the returned
 *  continuation until `complete: true`. Returns the merged finalized
 *  schemas, total cumulative ops from the LAST batch (which carries the
 *  cumulative totals), and the per-batch event lists. */
async function drain(
  db: ReturnType<typeof buildMockFirestore>,
  store: SessionStore<PersistedCrawlState>,
  maxBatchBytes: number,
  maxBatches = 1000,
) {
  const batchEvents: Array<unknown[]> = [];
  let continuation: string | undefined;
  let lastResult: Awaited<ReturnType<typeof crawl>> | undefined;
  let batches = 0;

  while (true) {
    if (++batches > maxBatches) throw new Error(`drain exceeded ${maxBatches} batches`);
    const opts = continuation
      ? { maxBatchBytes, maxConcurrency: 4, continuation }
      : { maxBatchBytes, maxConcurrency: 4 };
    lastResult = await crawl(db, opts, store);
    batchEvents.push(lastResult.events);
    if (lastResult.complete) break;
    continuation = lastResult.continuation;
    if (continuation === undefined) {
      throw new Error('Paused result missing continuation token');
    }
  }
  return { finalResult: lastResult!, batches, batchEvents };
}

// ─── 1. Single-call mode unchanged ────────────────────────────────────────

describe('crawl with SessionStore but no pause: behaves identically to single-call mode', () => {
  test('SessionStore + huge maxBatchBytes → same result as no store', async () => {
    const db1 = buildMockFirestore(wideTree(2, 3, 1));
    const db2 = buildMockFirestore(wideTree(2, 3, 1));

    const store = new SessionStore<PersistedCrawlState>();
    const withStore = await crawl(db1, { maxBatchBytes: 100_000_000 }, store);
    const withoutStore = await crawl(db2, {});

    expect(withStore.complete).toBe(true);
    expect(withStore.continuation).toBeUndefined();
    expect([...withStore.finalizedSchemas.keys()].sort()).toEqual(
      [...withoutStore.finalizedSchemas.keys()].sort(),
    );
    expect(withStore.listOps).toBe(withoutStore.listOps);
    expect(withStore.readOps).toBe(withoutStore.readOps);
    // Store should be empty — no continuation was minted.
    expect(store.size).toBe(0);
  });
});

// ─── 2. Byte-for-byte equivalence under forced pauses ────────────────────

describe('multi-batch crawl produces same finalizedSchemas as single-batch crawl', () => {
  test('split crawl ↔ single crawl: identical finalized schemas (small fixture)', async () => {
    const spec = wideTree(2, 2, 1);

    const single = await crawl(buildMockFirestore(spec), { maxConcurrency: 4 });

    const store = new SessionStore<PersistedCrawlState>();
    const split = await drain(buildMockFirestore(spec), store, 256);

    expect(split.batches).toBeGreaterThan(1); // confirm pauses actually fired
    expect(split.finalResult.complete).toBe(true);

    // Same set of templatePaths.
    const singleKeys = [...single.finalizedSchemas.keys()].sort();
    const splitKeys = [...split.finalResult.finalizedSchemas.keys()].sort();
    expect(splitKeys).toEqual(singleKeys);

    // Per-template equivalence: same samplingComplete and same observed
    // field set (we don't compare samplesSeen byte-for-byte because
    // structure-phase and sampling-phase docRefs are the same source).
    for (const k of singleKeys) {
      const s = single.finalizedSchemas.get(k)!;
      const m = split.finalResult.finalizedSchemas.get(k)!;
      expect(m.samplingComplete).toBe(s.samplingComplete);
      expect(m.schema.samplesSeen).toBe(s.schema.samplesSeen);
      expect(Object.keys(m.schema.fields).sort()).toEqual(Object.keys(s.schema.fields).sort());
      expect(m.subcollectionTemplatePaths.sort()).toEqual(s.subcollectionTemplatePaths.sort());
    }
  });

  test('larger fixture also drains and matches', async () => {
    const spec = wideTree(3, 4, 2);

    const single = await crawl(buildMockFirestore(spec), { maxConcurrency: 4 });

    const store = new SessionStore<PersistedCrawlState>();
    const split = await drain(buildMockFirestore(spec), store, 512);

    expect(split.batches).toBeGreaterThan(1);
    expect(split.finalResult.complete).toBe(true);
    expect([...split.finalResult.finalizedSchemas.keys()].sort()).toEqual(
      [...single.finalizedSchemas.keys()].sort(),
    );
  });
});

// ─── 3. Cumulative counters across batches ────────────────────────────────

describe('listOps and readOps accumulate across batches', () => {
  test('cumulative counters in the final batch match the single-call totals', async () => {
    const spec = wideTree(2, 3, 1);

    const single = await crawl(buildMockFirestore(spec), { maxConcurrency: 4 });

    const store = new SessionStore<PersistedCrawlState>();
    const split = await drain(buildMockFirestore(spec), store, 256);

    expect(split.batches).toBeGreaterThan(1);
    expect(split.finalResult.listOps).toBe(single.listOps);
    expect(split.finalResult.readOps).toBe(single.readOps);
  });
});

// ─── 4. Per-batch events ──────────────────────────────────────────────────

describe('events are per-batch, not cumulative', () => {
  test('concatenated per-batch events match the single-call event count', async () => {
    const spec = wideTree(2, 2, 1);

    const single = await crawl(buildMockFirestore(spec), { maxConcurrency: 4 });

    const store = new SessionStore<PersistedCrawlState>();
    const split = await drain(buildMockFirestore(spec), store, 256);

    const concat = split.batchEvents.flat();
    // Same count of events whether single-call or split-then-concat.
    expect(concat.length).toBe(single.events.length);
    // No batch carries the full event log on its own.
    for (const b of split.batchEvents) {
      expect(b.length).toBeLessThan(single.events.length);
    }
  });
});

// ─── 5. Structured continuation errors ────────────────────────────────────

describe('structured continuation errors', () => {
  test('SESSION_MALFORMED_TOKEN: bogus token string', async () => {
    const db = buildMockFirestore({ c: [{ id: 'd0', fields: { x: { stringValue: 'v' } } }] });
    const store = new SessionStore<PersistedCrawlState>();
    const result = await crawl(db, { continuation: 'not-a-real-token' }, store);
    expect(result.complete).toBe(true);
    expect(result.continuation).toBeUndefined();
    expect(result.events).toHaveLength(1);
    const ev = result.events[0]!;
    expect(ev.kind).toBe('error');
    if (ev.kind === 'error') {
      expect(ev.code).toBe('SESSION_MALFORMED_TOKEN');
    }
    // No partial work — empty maps.
    expect(result.finalizedSchemas.size).toBe(0);
    expect(result.discovered.size).toBe(0);
    expect(result.listOps).toBe(0);
    expect(result.readOps).toBe(0);
  });

  test('SESSION_EXPIRED: token whose session was swept by TTL', async () => {
    let nowMs = 1_000_000;
    const store = new SessionStore<PersistedCrawlState>({
      now: () => nowMs,
      ttlMs: 1_000,
    });
    const spec = wideTree(2, 3, 1);
    const db = buildMockFirestore(spec);

    // Drive a pause.
    const first = await crawl(db, { maxBatchBytes: 256, maxConcurrency: 4 }, store);
    expect(first.complete).toBe(false);
    const cont = first.continuation!;
    expect(cont).toBeDefined();

    // Fast-forward past TTL.
    nowMs += 5_000;

    const resumed = await crawl(db, { continuation: cont, maxConcurrency: 4 }, store);
    expect(resumed.complete).toBe(true);
    expect(resumed.events).toHaveLength(1);
    const ev = resumed.events[0]!;
    expect(ev.kind).toBe('error');
    if (ev.kind === 'error') {
      expect(ev.code).toBe('SESSION_EXPIRED');
    }
  });

  test('SESSION_EVICTED: oldest session bumped when maxSessions cap fires', async () => {
    const store = new SessionStore<PersistedCrawlState>({ maxSessions: 1 });
    const spec = wideTree(2, 3, 1);
    const dbA = buildMockFirestore(spec);
    const dbB = buildMockFirestore(spec);

    // Pause crawl A — store now holds A's session.
    const a1 = await crawl(dbA, { maxBatchBytes: 256, maxConcurrency: 4 }, store);
    expect(a1.complete).toBe(false);
    const tokenA = a1.continuation!;

    // Start a fresh crawl B that pauses too — this evicts A.
    const b1 = await crawl(dbB, { maxBatchBytes: 256, maxConcurrency: 4 }, store);
    expect(b1.complete).toBe(false);
    expect(b1.continuation).toBeDefined();

    // A's resume now fails with SESSION_EVICTED.
    const aResume = await crawl(dbA, { continuation: tokenA, maxConcurrency: 4 }, store);
    expect(aResume.complete).toBe(true);
    expect(aResume.events).toHaveLength(1);
    const ev = aResume.events[0]!;
    expect(ev.kind).toBe('error');
    if (ev.kind === 'error') {
      expect(ev.code).toBe('SESSION_EVICTED');
    }
  });

  test('NO_SESSION_STORE: continuation passed without a store', async () => {
    const db = buildMockFirestore({ c: [{ id: 'd0', fields: { x: { stringValue: 'v' } } }] });
    const result = await crawl(db, { continuation: 'disc_anything' });
    expect(result.complete).toBe(true);
    expect(result.events).toHaveLength(1);
    const ev = result.events[0]!;
    expect(ev.kind).toBe('error');
    if (ev.kind === 'error') {
      expect(ev.code).toBe('NO_SESSION_STORE');
    }
  });
});

// ─── 6. Session cleanup on completion ─────────────────────────────────────

describe('session cleanup', () => {
  test('completed crawl removes its session from the store', async () => {
    const store = new SessionStore<PersistedCrawlState>();
    const spec = wideTree(2, 3, 1);
    const db = buildMockFirestore(spec);

    const split = await drain(db, store, 256);
    expect(split.finalResult.complete).toBe(true);
    expect(store.size).toBe(0); // session was deleted on completion
  });
});

// ─── 7. Pause boundaries — phase classification ───────────────────────────

describe('pause boundaries — observable via persisted state.phase', () => {
  test('first pause lands on a structure-layer boundary OR a sampling boundary', async () => {
    // We pick a small fixture and a tiny budget so the very first pause
    // happens early. We then peek at the persisted state via the store
    // to confirm the phase is one of the two valid pause states (i.e.,
    // we never pause mid-RPC or in some "transition" pseudo-state).
    const store = new SessionStore<PersistedCrawlState>();
    const spec = wideTree(2, 3, 1);
    const db = buildMockFirestore(spec);

    const first = await crawl(db, { maxBatchBytes: 256, maxConcurrency: 4 }, store);
    expect(first.complete).toBe(false);
    const cont = first.continuation!;

    const lookup = store.get(cont);
    expect(lookup.ok).toBe(true);
    if (lookup.ok) {
      const phase = lookup.value.state.phase;
      expect(phase === 'structure' || phase === 'sampling').toBe(true);
      // If we paused in structure phase, we expect either a pending
      // frontier (more layers to walk) or having transitioned just
      // after layer-0 work. Either way, samplingQueue should be empty
      // until structure completes.
      if (phase === 'structure') {
        expect(lookup.value.state.samplingQueue.length).toBe(0);
      } else {
        // sampling phase: structure done, queue holds remaining work
        expect(lookup.value.state.frontierPaths.length).toBe(0);
      }
    }
  });
});
