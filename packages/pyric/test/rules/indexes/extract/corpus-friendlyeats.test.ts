/**
 * End-to-end corpus test: validates the Layer 1 extractor against the
 * friendlyeats real-world fixture. Mirrors the v1 scope's recall/precision
 * measurement now that the pipeline is productionized.
 *
 * - source.stitched.js is the post-inter-procedural shape Layer 2 will
 *   produce (INIT inlined into applyQueryFilters). Layer 1 should
 *   recover all 8 deployed indexes from it.
 * - source.original.js is the verbatim app code with the base in a
 *   different function from the wraps. Layer 1 should emit a
 *   `partial-base` warning for `applyQueryFilters`, documenting the
 *   inter-procedural gap that motivates Layer 2.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { extractIndexes } from '../../../../src/rules/indexes/extract/extractor.js';
import { indexEntryKey } from '../../../../src/rules/indexes/extract/composite.js';
import type { IndexesConfig, IndexesConfigEntry } from '../../../../src/rules/indexes/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../fixtures/firestore-indexes/friendlyeats');

function loadFixture(name: string): string {
  return readFileSync(resolve(fixtureDir, name), 'utf8');
}

function loadExpected(): IndexesConfig {
  const raw = JSON.parse(loadFixture('expected.indexes.json')) as {
    indexes: Array<{
      collectionGroup: string;
      queryScope: string;
      fields: Array<{ fieldPath: string; order?: string }>;
    }>;
  };
  // The deployed JSON uses queryScope as the literal string we encode
  // in IndexesConfigEntry, so cast through. Field-level order strings
  // are already 'ASCENDING'/'DESCENDING'.
  return { indexes: raw.indexes as IndexesConfigEntry[] };
}

describe('friendlyeats corpus — recall (stitched body)', () => {
  test('all 8 deployed indexes are recovered from the stitched source', () => {
    const expected = loadExpected();
    const result = extractIndexes({
      files: [{ name: 'firestore.stitched.js', source: loadFixture('source.stitched.js') }],
    });
    if (!result.success) throw new Error('extractIndexes failed');

    const extractedKeys = new Set(result.data.config.indexes.map(indexEntryKey));
    const missing: string[] = [];
    for (const idx of expected.indexes) {
      const k = indexEntryKey(idx);
      if (!extractedKeys.has(k)) missing.push(k);
    }
    expect(missing).toEqual([]);
    // Sanity: ground truth has 8 entries.
    expect(expected.indexes).toHaveLength(8);
  });

  test('over-shoot signal fires (precision gap left for Layer 2)', () => {
    // The 3-skippable-where × 2-mutex-orderBy pattern enumerates
    // 24 shapes (8 where-combos × 3 orderBy choices including skip).
    // That's well above the OVERSHOOT_THRESHOLD of 3 — so the
    // restaurants signal should flag overshootSuspected=true.
    const result = extractIndexes({
      files: [{ name: 'firestore.stitched.js', source: loadFixture('source.stitched.js') }],
    });
    if (!result.success) throw new Error('extractIndexes failed');
    const sig = result.data.signals.find(s => s.collectionGroup === 'restaurants');
    expect(sig).toBeDefined();
    expect(sig!.overshootSuspected).toBe(true);
    // Recall is 8/8 but precision is intentionally low — extracted
    // entries exceed deployed by a comfortable margin.
    expect(result.data.config.indexes.length).toBeGreaterThan(8);
  });
});

describe('friendlyeats corpus — Layer 2.5 inter-procedural recall (original body)', () => {
  test('original file recovers the same indexes as the stitched body', () => {
    // Pre-Layer-2.5 this fixture surfaced a partial-base warning for
    // applyQueryFilters because the INIT lived in getRestaurants /
    // getRestaurantsSnapshot. Layer 2.5's same-file follower inlines
    // the wrapper at both callers, so recall against the deployed set
    // matches the stitched fixture.
    const expected = loadExpected();
    const original = extractIndexes({
      files: [{ name: 'firestore.original.js', source: loadFixture('source.original.js') }],
    });
    if (!original.success) throw new Error('extractIndexes failed');

    const extractedKeys = new Set(original.data.config.indexes.map(indexEntryKey));
    const missing: string[] = [];
    for (const idx of expected.indexes) {
      const k = indexEntryKey(idx);
      if (!extractedKeys.has(k)) missing.push(k);
    }
    // Same 8/8 deployed-recall as the stitched fixture.
    expect(missing).toEqual([]);
  });

  test('original file no longer surfaces partial-base for applyQueryFilters', () => {
    const result = extractIndexes({
      files: [{ name: 'firestore.original.js', source: loadFixture('source.original.js') }],
    });
    if (!result.success) throw new Error('extractIndexes failed');

    const partialBase = result.data.warnings.filter(w => w.code === 'partial-base');
    expect(partialBase.some(w => w.message.includes('applyQueryFilters'))).toBe(false);
  });

  test('original file matches stitched config exactly (composite-dedupe across both callers)', () => {
    const original = extractIndexes({
      files: [{ name: 'firestore.original.js', source: loadFixture('source.original.js') }],
    });
    const stitched = extractIndexes({
      files: [{ name: 'firestore.stitched.js', source: loadFixture('source.stitched.js') }],
    });
    if (!original.success || !stitched.success) throw new Error('extractIndexes failed');

    const oKeys = new Set(original.data.config.indexes.map(indexEntryKey));
    const sKeys = new Set(stitched.data.config.indexes.map(indexEntryKey));
    // The original has TWO callers of applyQueryFilters
    // (getRestaurants + getRestaurantsSnapshot); composite-dedupe
    // collapses their identical wrapper-derived shapes to the same
    // set the stitched single-caller fixture produces.
    expect(oKeys).toEqual(sKeys);
  });
});

describe('friendlyeats corpus — Layer 2 precision recovery (annotated body)', () => {
  test('@firestore-mutex { category, city, price } lifts precision to 100% (matches v1 scope)', () => {
    const expected = loadExpected();
    const baseline = extractIndexes({
      files: [{ name: 'firestore.stitched.js', source: loadFixture('source.stitched.js') }],
    });
    const annotated = extractIndexes({
      files: [{ name: 'firestore.stitched.annotated.js', source: loadFixture('source.stitched.annotated.js') }],
    });
    if (!baseline.success || !annotated.success) throw new Error('extractIndexes failed');

    const expectedKeys = new Set(expected.indexes.map(indexEntryKey));
    const baselineKeys = new Set(baseline.data.config.indexes.map(indexEntryKey));
    const annotatedKeys = new Set(annotated.data.config.indexes.map(indexEntryKey));

    // Recall against the deployed set drops from 8/8 → 6/8 because the
    // mutex correctly removes (category, price) and (city, price) — the
    // v1 scope documented these two as historical artifacts the live source
    // never produces. Recall against what the code actually issues stays
    // at 100%. We assert the v1 scope's 75% deployed-recall floor.
    const annotatedRecallHits = [...expectedKeys].filter(k => annotatedKeys.has(k)).length;
    expect(annotatedRecallHits / expected.indexes.length).toBeGreaterThanOrEqual(0.75);

    // Precision lift: annotated must produce strictly fewer entries
    // than baseline, and every kept entry should match a deployed one
    // (precision ≥ 95% — v1 scope measured 100%).
    expect(annotated.data.config.indexes.length).toBeLessThan(baseline.data.config.indexes.length);

    const annotatedHitsAgainstDeployed = [...annotatedKeys].filter(k => expectedKeys.has(k)).length;
    const precision = annotatedHitsAgainstDeployed / annotated.data.config.indexes.length;
    expect(precision).toBeGreaterThanOrEqual(0.95);

    // Every dropped entry must contain ≥2 fields from the mutex group
    // — that's the rule the annotation enforces.
    const dropped = [...baselineKeys].filter(k => !annotatedKeys.has(k));
    for (const k of dropped) {
      const mutexFields = ['category', 'city', 'price'].filter(f => k.includes(f)).length;
      expect(mutexFields).toBeGreaterThanOrEqual(2);
    }
  });

  test('annotation surfaces in annotationsApplied with non-zero mutex prune count', () => {
    const result = extractIndexes({
      files: [{ name: 'firestore.stitched.annotated.js', source: loadFixture('source.stitched.annotated.js') }],
    });
    if (!result.success) throw new Error('extractIndexes failed');

    const applied = result.data.annotationsApplied.find(a => a.functionName === 'applyQueryFilters');
    expect(applied).toBeDefined();
    expect(applied!.prunedByMutex).toBeGreaterThan(0);
    expect(applied!.prunedByRequired).toBe(0);
    expect(applied!.annotations.mutexGroups).toHaveLength(1);
    expect([...applied!.annotations.mutexGroups[0]].sort()).toEqual(['category', 'city', 'price']);
  });
});
