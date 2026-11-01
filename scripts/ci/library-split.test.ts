import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import rootManifest from '../../package.json';

// library-tests runs packages/pyric in two shards plus test:ci:libraries:rest,
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

  test('test:ci:libraries:rest is exactly test:ci:libraries:core minus packages/pyric, which runs sharded', () => {
    const scripts = rootManifest.scripts as Record<string, string>;
    expect(`bun test --cwd packages/pyric && ${scripts['test:ci:libraries:rest']}`).toBe(scripts['test:ci:libraries:core']);
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
