import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('example page', () => {
  it('derives its finite routes from the computed registry', () => {
    const source = readFileSync(
      new URL('../../src/pages/examples/[example].astro', import.meta.url),
      'utf8',
    );
    expect(source).toContain('Object.keys(PYRIC_EXAMPLES)');
  });
});
