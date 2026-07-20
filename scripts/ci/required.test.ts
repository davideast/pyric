import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requiredFailures } from './required.ts';

const success = {
  'build-and-test': 'success',
  'library-tests': 'success',
  'browser-conformance': 'success',
  'release-contract': 'skipped',
  'docs-only': 'success',
  packaging: 'skipped',
  'install-matrix': 'skipped',
  standalone: 'skipped',
};

describe('required CI result', () => {
  test('the aggregate job receives every result its packaging policy requires', () => {
    const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    const requiredJob = workflow.slice(workflow.indexOf('\n  required:'));
    const needsLine = requiredJob.match(/\n    needs: \[([^\]]+)\]/)?.[1] ?? '';
    expect(needsLine.split(',').map((job) => job.trim())).toEqual(
      expect.arrayContaining(['packaging', 'install-matrix', 'standalone']),
    );
  });

  test('accepts skipped jobs only when their check set did not select them', () => {
    expect(requiredFailures({ checkSet: 'full', requirePackaging: false, results: success })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'release-only',
      requirePackaging: false,
      results: { ...success, 'build-and-test': 'skipped', 'library-tests': 'skipped', 'browser-conformance': 'skipped', 'docs-only': 'skipped', 'release-contract': 'success' },
    })).toEqual([]);
  });

  test('ignores a missing or failed independent Playground result', () => {
    expect(requiredFailures({
      checkSet: 'full',
      requirePackaging: false,
      results: success,
    })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'full',
      requirePackaging: false,
      results: { ...success, 'playground-caniuse': 'failure' },
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
    results: { 'build-and-test': 'success', 'library-tests': 'success', 'browser-conformance': 'success', 'docs-only': 'skipped' },
  })).toEqual(['docs-only: skipped']);
});
