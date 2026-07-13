import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { exports: Record<string, unknown> };

describe('@pyric/cli package manifest', () => {
  it('does not publish retired programmatic entry points', () => {
    expect(Object.keys(manifest.exports)).not.toContain('./deploy');
    expect(Object.keys(manifest.exports)).not.toContain('./credentials');
    expect(Object.keys(manifest.exports)).not.toContain('./auth');
    expect(Object.keys(manifest.exports)).not.toContain('./registry');
  });
});
