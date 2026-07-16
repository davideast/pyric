import { describe, expect, test } from 'bun:test';
import { validatePublishVersions } from './lib/check-publish-version.mjs';

describe('publish version validation', () => {
  test('accepts publishable packages at the requested version', () => {
    expect(
      validatePublishVersions('0.1.0-alpha.9', [
        { name: 'pyric', version: '0.1.0-alpha.9' },
        { name: '@pyric/cli', version: '0.1.0-alpha.9' },
      ]),
    ).toEqual([]);
  });

  test('reports every package that does not match the requested version', () => {
    expect(
      validatePublishVersions('0.1.0-alpha.9', [
        { name: 'pyric', version: '0.1.0-alpha.8' },
        { name: 'pyric-admin', version: '0.1.0-alpha.9' },
        { name: '@pyric/cli', version: '0.1.0-alpha.7' },
      ]),
    ).toEqual([
      'pyric is 0.1.0-alpha.8 (expected 0.1.0-alpha.9)',
      '@pyric/cli is 0.1.0-alpha.7 (expected 0.1.0-alpha.9)',
    ]);
  });
});
