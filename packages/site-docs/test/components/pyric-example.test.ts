import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('PyricExample', () => {
  it('isolates the executable example in an iframe', () => {
    const source = readFileSync(
      new URL('../../src/components/pyric-example.astro', import.meta.url),
      'utf8',
    );
    expect(source).toContain('sandbox="allow-scripts allow-same-origin"');
  });
});
