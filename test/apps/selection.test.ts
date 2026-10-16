import { describe, expect, test } from 'bun:test';
import { parseArguments, selectApps, skippedSlowClause } from './selection.ts';

const available = ['admin-writes', 'host-closes-silent-page', 'hosted-restart'];
const slow = new Set(['host-closes-silent-page']);

describe('slow app selection', () => {
  test('--skip-slow leaves the slow apps out and reports them', () => {
    expect(selectApps({ available, names: [], slow, filter: 'skip' })).toEqual({
      run: ['admin-writes', 'hosted-restart'],
      skippedSlow: ['host-closes-silent-page'],
    });
  });

  test('--only-slow runs the slow apps alone', () => {
    expect(selectApps({ available, names: [], slow, filter: 'only' })).toEqual({
      run: ['host-closes-silent-page'],
      skippedSlow: [],
    });
  });

  test('without a slow flag every app runs', () => {
    expect(selectApps({ available, names: [], slow, filter: 'include' }).run).toEqual(available);
  });

  test('a named app runs whatever its marker says', () => {
    expect(selectApps({ available, names: ['host-closes-silent-page'], slow, filter: 'skip' })).toEqual({
      run: ['host-closes-silent-page'],
      skippedSlow: [],
    });
    expect(selectApps({ available, names: ['admin-writes'], slow, filter: 'only' }).run).toEqual(['admin-writes']);
  });

  test('the summary names the skipped apps, and says nothing when none were skipped', () => {
    expect(skippedSlowClause(['host-closes-silent-page'])).toBe('; skipped 1 slow app (host-closes-silent-page)');
    expect(skippedSlowClause(['a', 'b'])).toBe('; skipped 2 slow apps (a, b)');
    expect(skippedSlowClause([])).toBe('');
  });
});

describe('runner options', () => {
  test('the slow flags set the filter', () => {
    expect(parseArguments([]).slow).toBe('include');
    expect(parseArguments(['--skip-slow']).slow).toBe('skip');
    expect(parseArguments(['--only-slow', '--packages', 'dist/packages']).slow).toBe('only');
  });

  test('--skip-slow and --only-slow together are refused', () => {
    expect(() => parseArguments(['--skip-slow', '--only-slow'])).toThrow('cannot be used together');
  });

  test('names, packages and the package directory from the environment still parse', () => {
    const options = parseArguments(['--jobs', '2', 'hosted-restart'], { PYRIC_PACKAGE_ARTIFACT_DIR: 'out' });
    expect(options).toMatchObject({ names: ['hosted-restart'], jobs: 2, packages: 'out', slow: 'include' });
  });
});

describe('the slow markers in test/apps', () => {
  test('host-closes-silent-page waits on its liveness window, so it is marked slow', async () => {
    const module = await import('./host-closes-silent-page/scenario.ts') as { slow?: unknown };
    expect(module.slow).toBe(true);
  });
});
