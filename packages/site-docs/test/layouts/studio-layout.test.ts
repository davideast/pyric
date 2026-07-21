import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('StudioLayout', () => {
  it('mounts the browser-only Studio application as a client island', () => {
    const source = readFileSync(
      new URL('../../src/layouts/studio-layout.astro', import.meta.url),
      'utf8',
    );
    expect(source).toContain('<StudioApp client:only="react" />');
    expect(source).toContain("from '@pyric/studio/app'");
  });
});
