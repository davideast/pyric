import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requiredFailures } from './required.ts';

const success = {
  'build-and-test': 'success',
  'library-tests': 'success',
  'browser-conformance': 'success',
  'conformance-gates': 'success',
  'release-contract': 'skipped',
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
      results: { ...success, 'build-and-test': 'skipped', 'library-tests': 'skipped', 'browser-conformance': 'skipped', 'conformance-gates': 'skipped', 'release-contract': 'success' },
    })).toEqual([]);
  });

  test('rejects a skipped conformance-gates job on the full check set', () => {
    expect(requiredFailures({
      checkSet: 'full',
      requirePackaging: false,
      results: { ...success, 'conformance-gates': 'skipped' },
    })).toEqual(['conformance-gates: skipped']);
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

  test('does not require a build for authored-documentation-only changes', () => {
    expect(requiredFailures({
      checkSet: 'docs-only',
      requirePackaging: false,
      results: {},
    })).toEqual([]);
  });

  test('requires every packaging consumer (incl. the standalone smoke) when the packaging policy is active', () => {
    expect(requiredFailures({
      checkSet: 'full',
      requirePackaging: true,
      results: success,
    })).toEqual(['packaging: skipped', 'install-matrix: skipped', 'standalone: skipped']);
  });
});
