import { describe, it, expect } from 'bun:test';
import {
  truncateVectorsForDisplay,
  vectorPreview,
  asVectorView,
} from '../../src/firestore/types.js';

const sentinel = (vals: number[]) => ({ __type__: '__vector__', value: vals });

describe('truncateVectorsForDisplay', () => {
  it('replaces a top-level vector with a compact preview string', () => {
    const big = Array.from({ length: 1536 }, (_, i) => i / 1000);
    const out = truncateVectorsForDisplay(sentinel(big));
    expect(typeof out).toBe('string');
    expect(out as string).toContain('vector · 1536');
    expect((out as string).length).toBeLessThan(80); // not the full 1536-float array
  });

  it('replaces a vector nested inside a document, leaving scalars intact', () => {
    const doc = { title: 'x', embedding: sentinel([0.1, 0.2, 0.3, 0.4, 0.5]), count: 42 };
    const out = truncateVectorsForDisplay(doc) as Record<string, unknown>;
    expect(out.title).toBe('x');
    expect(out.count).toBe(42);
    expect(typeof out.embedding).toBe('string');
    expect(out.embedding as string).toContain('vector · 5');
    // the raw `value` array key must be gone — nothing dumped the full vector
    expect(JSON.stringify(out)).not.toContain('"value"');
  });

  it('replaces vectors inside arrays', () => {
    const out = truncateVectorsForDisplay([sentinel([1, 2, 3, 4, 5, 6]), 'scalar']) as unknown[];
    expect(typeof out[0]).toBe('string');
    expect(out[1]).toBe('scalar');
  });

  it('leaves non-vector values untouched (a bare number[] is NOT a vector)', () => {
    expect(truncateVectorsForDisplay(42)).toBe(42);
    expect(truncateVectorsForDisplay('hi')).toBe('hi');
    expect(truncateVectorsForDisplay(null)).toBe(null);
    expect(truncateVectorsForDisplay([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('vectorPreview', () => {
  it('shows dimension + first 4 components + ellipsis', () => {
    const view = asVectorView(sentinel([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]))!;
    expect(vectorPreview(view)).toBe('vector · 6 [0.1, 0.2, 0.3, 0.4, …]');
  });

  it('shows a short vector in full without an ellipsis', () => {
    const view = asVectorView(sentinel([1, 2, 3]))!;
    expect(vectorPreview(view)).toBe('vector · 3 [1, 2, 3]');
  });
});
