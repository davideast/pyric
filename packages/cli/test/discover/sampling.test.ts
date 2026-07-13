/**
 * Item 3.2 — Lock the 4-state `samplingComplete` enum.
 *
 * Phase 2.2 + Phase 2.1 locked exactly four termination states:
 *   - `converged_via_exhausted` — read every available doc, no early-exit
 *   - `converged_via_max`       — `maxSamples` cap fired before exhaustion
 *   - `converged_via_stable`    — `stopOnStable` early-exit fired
 *   - `sampling_open`           — couldn't finish (error budget tripped)
 *
 * This file pins:
 *   1. The defaults (`stopOnStable=8`, `maxSamples=50`,
 *      `maxErrorsPerCollection=3`) match Phase 2 locks exactly.
 *   2. Each state fires under realistic conditions across a small, medium,
 *      and large synthetic stream — the 4×3 classification matrix.
 *   3. Classification priority (error > stable > exhausted > max) holds
 *      when multiple termination conditions could apply.
 *
 * Item 4 will extend the `sampling_open` semantic to also fire on
 * continuation-boundary interrupts. For now the sole trigger is error budget.
 */

import { describe, expect, test } from 'bun:test';
import { crawl } from '../../src/discover/crawler.js';
import type {
  CrawlerCollectionRef,
  CrawlerDocumentRef,
  CrawlerFirestore,
  WireDocumentSnapshot,
} from '../../src/discover/firestore-source.js';
import { buildMockFirestore, type DocSpec } from './helpers/mock-firestore.js';

// ─── Stream factories ─────────────────────────────────────────────────────

/** N docs with the SAME shape — early-exit candidate. */
function homogeneousStream(n: number): DocSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    fields: { x: { stringValue: 'same' } },
  }));
}

/** N docs each introducing a NEW field — never converges via stable. */
function divergingStream(n: number): DocSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    fields: { [`f${i}`]: { stringValue: `v${i}` } },
  }));
}

function permissionError(message = 'permission denied'): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = 7;
  return err;
}

/**
 * Build a Firestore mock where every `.get()` throws PERMISSION_DENIED.
 * Used to drive the `sampling_open` state via error-budget exhaustion.
 */
function failingGetFirestore(collId: string, n: number): CrawlerFirestore {
  const docs: CrawlerDocumentRef[] = Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    path: `${collId}/d${i}`,
    async listCollections() {
      return [];
    },
    async get(): Promise<WireDocumentSnapshot> {
      throw permissionError(`doc ${i} denied`);
    },
  }));
  const coll: CrawlerCollectionRef = {
    id: collId,
    path: collId,
    async listDocuments() {
      return docs;
    },
  };
  return {
    async listCollections() {
      return [coll];
    },
  };
}

// ─── Locked defaults ──────────────────────────────────────────────────────

describe('Phase 2 locks — defaults applied when options omitted', () => {
  test('default stopOnStable=8: homogeneous stream declares at index 8', async () => {
    // No options passed — must use the locked default.
    const db = buildMockFirestore({ c: homogeneousStream(20) });
    const result = await crawl(db);
    const cs = result.finalizedSchemas.get('c')!;
    expect(cs.samplingComplete).toBe('converged_via_stable');
    expect(cs.declaredAt).toBe(8);
  });

  test('default maxSamples=50: stream of 200 stops at 50 (no convergence)', async () => {
    // Diverging stream (every doc adds a field) so stopOnStable can't fire.
    // Cap should bite at exactly 50 reads.
    const db = buildMockFirestore({ c: divergingStream(200) });
    const result = await crawl(db);
    const cs = result.finalizedSchemas.get('c')!;
    expect(cs.samplingComplete).toBe('converged_via_max');
    expect(cs.schema.samplesSeen).toBe(50);
    expect(result.readOps).toBe(50);
  });

  test('default maxErrorsPerCollection=3: 3rd .get() failure trips budget', async () => {
    const db = failingGetFirestore('c', 10);
    const result = await crawl(db, { maxConcurrency: 1 });
    const cs = result.finalizedSchemas.get('c')!;
    expect(cs.samplingComplete).toBe('sampling_open');
    const errors = result.events.filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(3);
  });
});

// ─── 4-state classification matrix ────────────────────────────────────────

describe('samplingComplete classification matrix — small / medium / large', () => {
  // ── converged_via_exhausted ───────────────────────────────────────────
  describe('converged_via_exhausted (read every available doc, no cap, no early-exit)', () => {
    // Use a diverging stream so stable never fires; size below maxSamples
    // so cap never bites — only exhaustion remains.

    test('small (3 docs)', async () => {
      const db = buildMockFirestore({ c: divergingStream(3) });
      const result = await crawl(db, { maxSamples: 50, stopOnStable: 100 });
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('converged_via_exhausted');
      expect(cs.schema.samplesSeen).toBe(3);
      expect(cs.declaredAt).toBeNull();
    });

    test('medium (25 docs)', async () => {
      const db = buildMockFirestore({ c: divergingStream(25) });
      const result = await crawl(db, { maxSamples: 50, stopOnStable: 100 });
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('converged_via_exhausted');
      expect(cs.schema.samplesSeen).toBe(25);
    });

    test('large (49 docs — one short of cap)', async () => {
      const db = buildMockFirestore({ c: divergingStream(49) });
      const result = await crawl(db, { maxSamples: 50, stopOnStable: 100 });
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('converged_via_exhausted');
      expect(cs.schema.samplesSeen).toBe(49);
    });
  });

  // ── converged_via_max ─────────────────────────────────────────────────
  describe('converged_via_max (cap fires before exhaustion or stability)', () => {
    test('small cap (maxSamples=2 vs 5 docs)', async () => {
      const db = buildMockFirestore({ c: divergingStream(5) });
      const result = await crawl(db, { maxSamples: 2, stopOnStable: 100 });
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('converged_via_max');
      expect(cs.schema.samplesSeen).toBe(2);
    });

    test('medium cap (maxSamples=20 vs 50 docs)', async () => {
      const db = buildMockFirestore({ c: divergingStream(50) });
      const result = await crawl(db, { maxSamples: 20, stopOnStable: 100 });
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('converged_via_max');
      expect(cs.schema.samplesSeen).toBe(20);
    });

    test('large cap (maxSamples=50 vs 200 docs)', async () => {
      const db = buildMockFirestore({ c: divergingStream(200) });
      const result = await crawl(db, { maxSamples: 50, stopOnStable: 100 });
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('converged_via_max');
      expect(cs.schema.samplesSeen).toBe(50);
    });
  });

  // ── converged_via_stable ──────────────────────────────────────────────
  describe('converged_via_stable (stopOnStable early-exit fires)', () => {
    test('small (3 docs, stopOnStable=2)', async () => {
      // d0: change. d1: no change → 1. d2: no change → 2 → declare.
      const db = buildMockFirestore({ c: homogeneousStream(3) });
      const result = await crawl(db, { stopOnStable: 2, maxSamples: 50 });
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('converged_via_stable');
      expect(cs.declaredAt).toBe(2);
    });

    test('medium (50 docs, stopOnStable=8 default)', async () => {
      const db = buildMockFirestore({ c: homogeneousStream(50) });
      const result = await crawl(db);
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('converged_via_stable');
      expect(cs.declaredAt).toBe(8);
    });

    test('large (200 docs, stopOnStable=8 default — early-exit saves reads)', async () => {
      const db = buildMockFirestore({ c: homogeneousStream(200) });
      const result = await crawl(db, { maxSamples: 200 });
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('converged_via_stable');
      expect(cs.declaredAt).toBe(8);
      // Chunk size = stopOnStable = 8. Two chunks fetched (16 reads) before
      // d8 of the second chunk triggers exit. Worst-case wasted reads
      // = stopOnStable - 1 = 7.
      expect(result.readOps).toBeLessThanOrEqual(16);
    });
  });

  // ── sampling_open ─────────────────────────────────────────────────────
  describe('sampling_open (error budget exhausted)', () => {
    test('small stream — all docs fail .get()', async () => {
      const db = failingGetFirestore('c', 3);
      const result = await crawl(db, { maxErrorsPerCollection: 3 });
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('sampling_open');
    });

    test('medium stream — first 3 fails trip budget, rest unsampled', async () => {
      const db = failingGetFirestore('c', 25);
      const result = await crawl(db, { maxErrorsPerCollection: 3, maxConcurrency: 1 });
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('sampling_open');
      expect(cs.schema.samplesSeen).toBe(0);
      const errors = result.events.filter((e) => e.kind === 'error');
      expect(errors).toHaveLength(3);
    });

    test('large stream — error budget tripping does not depend on stream length', async () => {
      const db = failingGetFirestore('c', 100);
      const result = await crawl(db, { maxErrorsPerCollection: 3, maxConcurrency: 1 });
      const cs = result.finalizedSchemas.get('c')!;
      expect(cs.samplingComplete).toBe('sampling_open');
      const errors = result.events.filter((e) => e.kind === 'error');
      expect(errors).toHaveLength(3);
    });
  });
});

// ─── Classification priority ──────────────────────────────────────────────

describe('classification priority — error > stable > exhausted > max', () => {
  test('error budget wins over stable: sampling_open even on homogeneous stream', async () => {
    // Mix: every .get() fails. Even though the stream IS homogeneous, the
    // error budget tripping should classify as sampling_open, not stable.
    const db = failingGetFirestore('c', 50);
    const result = await crawl(db, { maxErrorsPerCollection: 3, stopOnStable: 8 });
    expect(result.finalizedSchemas.get('c')!.samplingComplete).toBe('sampling_open');
  });

  test('stable wins over max: 100 stable docs with maxSamples=50 → converged_via_stable', async () => {
    // Both could fire. stopOnStable=8 fires first (declaredAt=8), so
    // priority dictates 'converged_via_stable' even though the cap exists.
    const db = buildMockFirestore({ c: homogeneousStream(100) });
    const result = await crawl(db, { maxSamples: 50, stopOnStable: 8 });
    const cs = result.finalizedSchemas.get('c')!;
    expect(cs.samplingComplete).toBe('converged_via_stable');
    expect(cs.declaredAt).toBe(8);
  });

  test('exhausted wins over max: stream length === maxSamples → exhausted (not max)', async () => {
    // When stream length exactly equals maxSamples and we read all of them,
    // `cappedByMax` is false (entry.docRefs.length === maxSamples, not >),
    // so we should classify as exhausted, not max.
    const db = buildMockFirestore({ c: divergingStream(10) });
    const result = await crawl(db, { maxSamples: 10, stopOnStable: 100 });
    const cs = result.finalizedSchemas.get('c')!;
    expect(cs.samplingComplete).toBe('converged_via_exhausted');
  });
});
