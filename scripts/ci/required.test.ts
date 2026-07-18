import { describe, expect, test } from 'bun:test';
import { requiredFailures } from './required.ts';

const success = {
  'build-and-test': 'success',
  'library-tests': 'success',
  'browser-conformance': 'success',
  'playground-caniuse': 'success',
  'release-contract': 'skipped',
  'docs-only': 'success',
  packaging: 'skipped',
  'install-matrix': 'skipped',
  standalone: 'skipped',
};

describe('required CI result', () => {
  test('accepts skipped jobs only when their check set did not select them', () => {
    expect(requiredFailures({ checkSet: 'full', requirePackaging: false, results: success })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'release-only',
      requirePackaging: false,
      results: { ...success, 'build-and-test': 'skipped', 'library-tests': 'skipped', 'browser-conformance': 'skipped', 'playground-caniuse': 'skipped', 'docs-only': 'skipped', 'release-contract': 'success' },
    })).toEqual([]);
  });

  test.each(['failure', 'cancelled', 'skipped', undefined])(
    'rejects a required job with result %s',
    (result) => {
      expect(requiredFailures({
        checkSet: 'docs-only',
        requirePackaging: false,
        results: { ...success, 'docs-only': result },
      })).toEqual([`docs-only: ${result ?? 'missing'}`]);
    },
  );

  test('requires every packaging consumer (incl. the standalone smoke) when the packaging policy is active', () => {
    expect(requiredFailures({
      checkSet: 'full',
      requirePackaging: true,
      results: success,
    })).toEqual(['packaging: skipped', 'install-matrix: skipped', 'standalone: skipped']);
  });
});

test('full runs require the documentation build (regression: docs gap)', () => {
  expect(requiredFailures({
    checkSet: 'full',
    requirePackaging: false,
    results: { 'build-and-test': 'success', 'library-tests': 'success', 'browser-conformance': 'success', 'playground-caniuse': 'success', 'docs-only': 'skipped' },
  })).toEqual(['docs-only: skipped']);
});
