import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('SiteLayout', () => {
  const source = readFileSync(
    new URL('../../src/layouts/site-layout.astro', import.meta.url),
    'utf8',
  );

  it('serves the shared logo as the base-aware favicon', () => {
    expect(source).toContain('href={`${base}pyric-logo.svg`}');
  });

  it('can apply Studio dark mode before the first paint', () => {
    expect(source).toContain("localStorage.setItem('pyric-studio:theme', 'dark')");
    expect(source).toContain("setAttribute('data-theme', 'dark')");
  });
});
