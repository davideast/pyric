import { describe, expect, test } from 'bun:test';
import { parseNameStatus, determinePackaging } from './plan.ts';

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
