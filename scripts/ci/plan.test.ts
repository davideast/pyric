import { describe, expect, test } from 'bun:test';
import { parseNameStatus, determineAppScenarios, determinePackaging, determineRtdbDifferential } from './plan.ts';

describe('app scenario selection', () => {
  test('runs for a pull request touching the Vite plugin, register hook, pyric-admin, AI broker, manifests, packaging, or apps', () => {
    for (const path of [
      'packages/cli/src/serve/vite-plugin.ts',
      'packages/cli/src/register/index.ts',
      'packages/cli/src/remote/index.ts',
      'packages/cli/src/cli/firebase-project.ts',
      'packages/pyric-admin/src/database/index.ts',
      'packages/pyric/src/ai/broker/gemini-engine.ts',
      'packages/cli/package.json',
      'scripts/pack-packages.sh',
      'test/apps/hosted-dev-server-restart/vite.config.js',
    ]) {
      expect(determineAppScenarios({ event: 'pull_request', paths: [{ path }] })).toBe(true);
    }
  });

  test('runs for a rename out of a selected directory', () => {
    expect(determineAppScenarios({
      event: 'pull_request',
      paths: [{ path: 'test/other/scenario.ts', previousPath: 'test/apps/a/scenario.ts' }],
    })).toBe(true);
  });

  test('skips a pull request that touches none of them', () => {
    expect(determineAppScenarios({ event: 'pull_request', paths: [{ path: 'packages/pyric/src/storage/index.ts' }] })).toBe(false);
  });

  test('always runs outside pull requests', () => {
    expect(determineAppScenarios({ event: 'schedule', paths: [] })).toBe(true);
    expect(determineAppScenarios({ event: 'push', paths: [] })).toBe(true);
  });
});

describe('RTDB differential selection', () => {
  test('runs for a pull request touching the served hosts, the RTDB engine, or the rules engine', () => {
    for (const path of [
      'packages/cli/src/serve/worker/host/rtdb.ts',
      'packages/pyric/src/database/listeners.ts',
      'packages/pyric/src/rules/internal/rtdb.ts',
      'packages/cli/test/serve/rtdb-differential/generator.ts',
    ]) {
      expect(determineRtdbDifferential({ event: 'pull_request', paths: [{ path }] })).toBe(true);
    }
  });

  test('runs for a rename out of a selected directory', () => {
    expect(determineRtdbDifferential({
      event: 'pull_request',
      paths: [{ path: 'packages/cli/src/other.ts', previousPath: 'packages/cli/src/serve/other.ts' }],
    })).toBe(true);
  });

  test('skips a pull request that touches none of them', () => {
    expect(determineRtdbDifferential({ event: 'pull_request', paths: [{ path: 'packages/pyric/src/storage/index.ts' }] })).toBe(false);
  });

  test('always runs outside pull requests', () => {
    expect(determineRtdbDifferential({ event: 'schedule', paths: [] })).toBe(true);
    expect(determineRtdbDifferential({ event: 'push', paths: [] })).toBe(true);
  });
});

describe('CI change input', () => {
  test('preserves both sides of renames and ordinary changed paths', () => {
    expect(parseNameStatus('M\0README.md\0R100\0docs/old.md\0docs/new.md\0D\0gone.txt\0')).toEqual([
      { path: 'README.md' },
      { path: 'docs/new.md', previousPath: 'docs/old.md' },
      { path: 'gone.txt' },
    ]);
  });

  test('forces packaging gate on push to main', () => {
    expect(determinePackaging({ event: 'push', labels: [], paths: [] })).toBe(true);
  });

  test('forces packaging gate when ci-packaging label is present', () => {
    expect(determinePackaging({ event: 'pull_request', labels: ['ci-packaging'], paths: [] })).toBe(true);
  });

  test('forces packaging gate when changed paths require packaging proof', () => {
    expect(determinePackaging({ event: 'pull_request', labels: [], paths: [{ path: 'packages/pyric/package.json' }] })).toBe(true);
  });

  test('skips packaging gate when no packaging proof required on PR', () => {
    expect(determinePackaging({ event: 'pull_request', labels: [], paths: [{ path: 'README.md' }] })).toBe(false);
  });
});
