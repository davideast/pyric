import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requiredFailures } from './required.ts';

const success = {
  'build-packages': 'success',
  'build-and-test': 'success',
  'library-tests': 'success',
  'conformance-suite': 'success',
  'browser-conformance': 'success',
  'conformance-gates': 'success',
  'native-conformance': 'success',
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

  test('only the experimental Kotlin client is non-blocking in native conformance', () => {
    const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    const nativeJob = workflow.slice(workflow.indexOf('\n  native-conformance:'), workflow.indexOf('\n  required:'));
    expect(nativeJob).toContain('continue-on-error: ${{ matrix.blocking == false }}');
    const entries = [...nativeJob.matchAll(/- sdk: (\w+)\n\s+os: [\w-]+\n\s+blocking: (true|false)/g)]
      .map(([, sdk, blocking]) => [sdk, blocking]);
    expect(Object.fromEntries(entries)).toEqual({ kotlin: 'false', flutter: 'true', swift: 'true' });
  });

  test('accepts skipped jobs only when their check set did not select them', () => {
    expect(requiredFailures({ checkSet: 'full', requirePackaging: false, results: success })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'release-only',
      requirePackaging: false,
      results: { ...success, 'build-packages': 'skipped', 'build-and-test': 'skipped', 'library-tests': 'skipped', 'conformance-suite': 'skipped', 'browser-conformance': 'skipped', 'conformance-gates': 'skipped', 'native-conformance': 'skipped', 'release-contract': 'success' },
    })).toEqual([]);
  });

  test('requires the RTDB differential gate only when the plan selected it', () => {
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireRtdbDifferential: false,
      results: { ...success, 'rtdb-differential': 'skipped' },
    })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireRtdbDifferential: true,
      results: { ...success, 'rtdb-differential': 'skipped' },
    })).toEqual(['rtdb-differential: skipped']);
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireRtdbDifferential: true,
      results: { ...success, 'rtdb-differential': 'success' },
    })).toEqual([]);
  });

  test('the aggregate job receives the RTDB differential result and the plan\'s selection', () => {
    const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    const requiredJob = workflow.slice(workflow.indexOf('\n  required:'));
    const needsLine = requiredJob.match(/\n    needs: \[([^\]]+)\]/)?.[1] ?? '';
    expect(needsLine.split(',').map((job) => job.trim())).toContain('rtdb-differential');
    expect(requiredJob).toContain('CI_REQUIRE_RTDB_DIFFERENTIAL: ${{ needs.plan.outputs.rtdb-differential }}');
  });

  test('requires the app scenarios only when the plan selected them', () => {
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireAppScenarios: false,
      results: { ...success, 'app-scenarios': 'skipped' },
    })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireAppScenarios: true,
      results: { ...success, 'app-scenarios': 'failure' },
    })).toEqual(['app-scenarios: failure']);
    expect(requiredFailures({
      checkSet: 'full', requirePackaging: false, requireAppScenarios: true,
      results: { ...success, 'app-scenarios': 'success' },
    })).toEqual([]);
  });

  test('the aggregate job receives the app scenario result and the plan\'s selection', () => {
    const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    const requiredJob = workflow.slice(workflow.indexOf('\n  required:'));
    const needsLine = requiredJob.match(/\n    needs: \[([^\]]+)\]/)?.[1] ?? '';
    expect(needsLine.split(',').map((job) => job.trim())).toContain('app-scenarios');
    expect(requiredJob).toContain('CI_REQUIRE_APP_SCENARIOS: ${{ needs.plan.outputs.app-scenarios }}');
  });

  test('requires the removal guard on every pull request, whatever the check set', () => {
    for (const checkSet of ['full', 'release-only', 'docs-only'] as const) {
      expect(requiredFailures({
        checkSet, requirePackaging: false, requireDeletionGuard: true,
        results: { 'deletion-guard': 'failure' },
      })).toContain('deletion-guard: failure');
    }
    expect(requiredFailures({
      checkSet: 'docs-only', requirePackaging: false, requireDeletionGuard: true,
      results: { 'deletion-guard': 'success' },
    })).toEqual([]);
    expect(requiredFailures({
      checkSet: 'docs-only', requirePackaging: false, requireDeletionGuard: false,
      results: { 'deletion-guard': 'skipped' },
    })).toEqual([]);
  });

  test('the aggregate job receives the removal guard result, required on pull requests', () => {
    const workflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    const requiredJob = workflow.slice(workflow.indexOf('\n  required:'));
    const needsLine = requiredJob.match(/\n    needs: \[([^\]]+)\]/)?.[1] ?? '';
    expect(needsLine.split(',').map((job) => job.trim())).toContain('deletion-guard');
    expect(requiredJob).toContain("CI_REQUIRE_DELETION_GUARD: ${{ github.event_name == 'pull_request' }}");
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
    })).toEqual(['packaging: skipped', 'install-matrix: skipped', 'standalone: skipped', 'release-contract: skipped']);
  });
});
