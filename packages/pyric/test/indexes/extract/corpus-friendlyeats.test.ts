/**
 * End-to-end corpus test: validates Firestore composite index extraction
 * against the FriendlyEats fixture across single-file and multi-file splits.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexEntryKey } from '../../../src/indexes/extract/composite.js';
import { extractIndexes } from '../../../src/indexes/extract/extractor.js';
import type { IndexesConfig, IndexesConfigEntry } from '../../../src/indexes/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../rules/fixtures/firestore-indexes/friendlyeats');

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
  return { indexes: raw.indexes as IndexesConfigEntry[] };
}

describe('friendlyeats corpus: recall (stitched body)', () => {
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
    expect(expected.indexes).toHaveLength(8);
  });

  test('over-shoot signal fires when optional filter combinations exceed threshold', () => {
    const result = extractIndexes({
      files: [{ name: 'firestore.stitched.js', source: loadFixture('source.stitched.js') }],
    });
    if (!result.success) throw new Error('extractIndexes failed');
    const sig = result.data.signals.find((s) => s.collectionGroup === 'restaurants');
    expect(sig).toBeDefined();
    expect(sig!.overshootSuspected).toBe(true);
    expect(result.data.config.indexes.length).toBeGreaterThan(8);
  });
});

describe('friendlyeats corpus: inter-procedural recall (original and multi-file split)', () => {
  test('original file recovers all 8 deployed indexes without unresolved warnings', () => {
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
    expect(missing).toEqual([]);
    expect(original.data.warnings).toEqual([]);
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
    expect(oKeys).toEqual(sKeys);
  });

  test('splitting applyQueryFilters into a separate module recovers all 8 deployed indexes', () => {
    const expected = loadExpected();
    const split = extractIndexes({
      files: [
        {
          name: 'src/filters.js',
          source: `
            import { orderBy, query, where } from "firebase/firestore";
            export function applyQueryFilters(q, { category, city, price, sort }) {
              if (category) q = query(q, where("category", "==", category));
              if (city) q = query(q, where("city", "==", city));
              if (price) q = query(q, where("price", "==", price.length));
              if (sort === "Rating" || !sort) {
                q = query(q, orderBy("avgRating", "desc"));
              } else if (sort === "Review") {
                q = query(q, orderBy("numRatings", "desc"));
              }
              return q;
            }
          `,
        },
        {
          name: 'src/restaurants.js',
          source: `
            import { collection, getDocs, onSnapshot, query } from "firebase/firestore";
            import { applyQueryFilters } from "./filters.js";
            export async function getRestaurants(db, filters = {}) {
              let q = query(collection(db, "restaurants"));
              q = applyQueryFilters(q, filters);
              return getDocs(q);
            }
            export function getRestaurantsSnapshot(db, cb, filters = {}) {
              let q = query(collection(db, "restaurants"));
              q = applyQueryFilters(q, filters);
              return onSnapshot(q, cb);
            }
          `,
        },
      ],
    });
    if (!split.success) throw new Error('extractIndexes failed');
    const extractedKeys = new Set(split.data.config.indexes.map(indexEntryKey));
    const missing = expected.indexes.map(indexEntryKey).filter((k) => !extractedKeys.has(k));
    expect(missing).toEqual([]);
    expect(split.data.warnings).toEqual([]);
  });
});
