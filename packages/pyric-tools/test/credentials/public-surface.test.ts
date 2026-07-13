import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as nodeCredentials from '../../src/credentials/node/index.js';

describe('@pyric/cli credential surface', () => {
  it('does not export the removed browser OAuth credential API', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(manifest.exports)).not.toContain('./credentials');
  });

  it('limits Node credentials to the sources supported by Rules Test API verification', () => {
    expect(Object.keys(nodeCredentials).sort()).toEqual([
      'fromAdc',
      'fromServiceAccount',
    ]);
  });
});
