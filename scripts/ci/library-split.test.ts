import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import rootManifest from '../../package.json';

// library-tests runs packages/pyric and packages/rules in three timed shards
// each, one of each per leg, plus test:ci:libraries:rest,
// the conformance suite runs in its own CI job, and the CLI suite in its own;
// together they must equal the canonical serial chain, test:serial, which
// `bun run test` runs through scripts/test-all.ts, or a suite added to one form
// silently escapes the other.
describe('CI library split', () => {
  test('test:ci:libraries is exactly test:serial minus the CLI suite, which runs as test:ci:cli', () => {
    const scripts = rootManifest.scripts as Record<string, string>;
    const cliSegment = ' && bun test --cwd packages/cli';
    expect(scripts['test:serial']).toContain(cliSegment);
    expect(scripts['test:serial'].replace(cliSegment, '')).toBe(scripts['test:ci:libraries']);
    expect(scripts['test:ci:cli']).toBe(cliSegment.slice(' && '.length));
  });

  test('test:ci:libraries:core is exactly test:ci:libraries minus the conformance suite', () => {
    const scripts = rootManifest.scripts as Record<string, string>;
    const conformanceSegment = ' && bun test --cwd packages/conformance';
    expect(scripts['test:ci:libraries']).toContain(conformanceSegment);
    expect(scripts['test:ci:libraries:core']).not.toContain('packages/conformance');
    expect(scripts['test:ci:libraries'].replace(conformanceSegment, ''))
      .toBe(scripts['test:ci:libraries:core']);
  });

  test('test:ci:libraries:rest is exactly test:ci:libraries:core minus packages/pyric and packages/rules, which run sharded', () => {
    const scripts = rootManifest.scripts as Record<string, string>;
    const sharded = 'bun test --cwd packages/pyric && bun test --cwd packages/rules';
    expect(`${sharded} && ${scripts['test:ci:libraries:rest']}`).toBe(scripts['test:ci:libraries:core']);
  });
});

// A workspace package's suite runs only if test:serial names it, and the CI
// forms above derive from test:serial, so a new package with tests that is
// left out of it never runs anywhere (#1521).
describe('workspace suites in test:serial', () => {
  const root = resolve(import.meta.dir, '../..');
  const scripts = rootManifest.scripts as Record<string, string>;

  /** Packages whose suites run outside test:serial, with where they run instead. */
  const RUN_ELSEWHERE: Readonly<Record<string, string>> = {
    // CI installs the workspace without it (--filter '!@pyric/playground'),
    // and playground-contract.yml runs its contract checks.
    'packages/playground': 'playground-contract.yml',
  };

  function packagesWithTests(): string[] {
    const out = Bun.spawnSync(['git', 'ls-files', '-z', '--', 'packages'], { cwd: root });
    if (out.exitCode !== 0) throw new Error('git ls-files failed');
    const files = out.stdout.toString().split('\0');
    const manifests = new Set(files.filter((path) => /^packages\/[^/]+\/package\.json$/.test(path)).map((path) => dirname(path)));
    const tested = files
      .filter((path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.split('/').includes('node_modules'))
      .map((path) => path.split('/').slice(0, 2).join('/'));
    return [...new Set(tested)].filter((dir) => manifests.has(dir)).sort();
  }

  function runsInSerial(dir: string): boolean {
    const segments = scripts['test:serial'].split(' && ');
    return segments.includes(`bun test --cwd ${dir}`) || segments.includes(`bun run --cwd ${dir} test`);
  }

  test('every package under packages/ with test files is in test:serial or names where it runs', () => {
    const packages = packagesWithTests();
    expect(packages).toContain('packages/rules');
    const missing = packages.filter((dir) => !runsInSerial(dir) && !(dir in RUN_ELSEWHERE));
    expect(missing, 'add `bun test --cwd <package>` to test:serial and the CI forms').toEqual([]);
  });

  test('a package listed as running elsewhere is not also in test:serial', () => {
    expect(Object.keys(RUN_ELSEWHERE).filter(runsInSerial)).toEqual([]);
  });
});

// A script test that waits on real timers is named `*.slow.test.ts` and runs
// only through test:slow, which slow-scenarios.yml runs on main, nightly and on
// pull requests labeled `ci-slow-scenarios`, so it never gates a pull request.
describe('slow script tests', () => {
  const root = resolve(import.meta.dir, '../..');
  const scripts = rootManifest.scripts as Record<string, string>;

  function slowTestFiles(): string[] {
    const out = Bun.spawnSync(['git', 'ls-files', '-z', '--', 'scripts'], { cwd: root });
    if (out.exitCode !== 0) throw new Error('git ls-files failed');
    return out.stdout.toString().split('\0').filter((path) => path.endsWith('.slow.test.ts'));
  }

  test('test:slow runs every slow script test', () => {
    const files = slowTestFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(scripts['test:slow']).toBe(`bun test ${files.sort().join(' ')}`);
  });

  test('no list that gates pull requests runs a slow script test', () => {
    for (const name of ['test:serial', 'test:ci:libraries', 'test:ci:libraries:core', 'test:ci:libraries:rest']) {
      expect({ name, slow: scripts[name].includes('.slow.test.') }).toEqual({ name, slow: false });
    }
  });

  test('the slow workflow runs test:slow', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/slow-scenarios.yml'), 'utf8');
    expect(workflow).toContain('run: bun run test:slow');
  });
});
