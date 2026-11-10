import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cliVersion } from '../src/pkg-version.js';
import type { EmbeddedAssets } from '../src/serve/standalone-assets.js';

const PACKAGE_ROOT = resolve(import.meta.dir, '..');
const ownVersion = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

function stubEmbedded(version: string): EmbeddedAssets {
  return {
    version,
    workerVersion: 'wv-test',
    sdk: async () => ({}),
    site: async () => ({}),
  };
}

describe('cliVersion', () => {
  const initialEmbedded = globalThis.__PYRIC_EMBEDDED__;

  afterEach(() => {
    globalThis.__PYRIC_EMBEDDED__ = initialEmbedded;
  });

  it('resolves @pyric/cli package.json version outside standalone mode and reflects runtime __PYRIC_EMBEDDED__ toggles immediately', () => {
    globalThis.__PYRIC_EMBEDDED__ = undefined;
    expect(ownVersion).not.toBe('0.0.0');
    expect(cliVersion()).toBe(ownVersion);

    globalThis.__PYRIC_EMBEDDED__ = stubEmbedded('9.8.7-standalone');
    expect(cliVersion()).toBe('9.8.7-standalone');

    globalThis.__PYRIC_EMBEDDED__ = stubEmbedded('9.8.8-standalone');
    expect(cliVersion()).toBe('9.8.8-standalone');

    globalThis.__PYRIC_EMBEDDED__ = undefined;
    expect(cliVersion()).toBe(ownVersion);
  });
});
