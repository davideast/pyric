import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('site root page', () => {
  it('uses the Studio layout for Home', () => {
    const source = readFileSync(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
    expect(source).toContain('<StudioLayout />');
  });
});
