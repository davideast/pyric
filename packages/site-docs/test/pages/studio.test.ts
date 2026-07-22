import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('finite Studio pages', () => {
  it('generates entries from the route model and uses the Studio layout', () => {
    const source = readFileSync(
      new URL('../../src/pages/[studio].astro', import.meta.url),
      'utf8',
    );
    expect(source).toContain('studioStaticPaths()');
    expect(source).toContain('<StudioLayout />');
  });
});
