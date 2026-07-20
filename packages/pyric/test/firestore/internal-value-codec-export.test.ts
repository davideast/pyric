import { describe, expect, it } from 'bun:test';
import manifest from '../../package.json';

describe('Firestore internal value codec export', () => {
  it('keeps the worker codec internal to Firestore instead of publishing a native surface', () => {
    const exportedSubpaths = Object.keys(manifest.exports);
    expect(exportedSubpaths).toContain('./firestore/internal/value-codec');
    expect(exportedSubpaths).not.toContain('./firestore-values');
  });
});
