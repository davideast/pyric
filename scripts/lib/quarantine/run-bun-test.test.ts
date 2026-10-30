// Runs real `bun test` processes on small suites written to a temporary
// directory, through the quarantine runner, and checks the exit code each ends
// with. No browser and no network.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { REPO_ROOT, addDays, entryFileName, type LoadedEntry } from './entries.ts';
import { runBunTest, runBunTestVerdict } from './run-bun-test.ts';

const TODAY = '2026-10-29';
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function suite(files: Record<string, string>): { cwd: string; id: (file: string, name?: string) => string } {
  const cwd = mkdtempSync(join(tmpdir(), 'quarantine-suite-'));
  dirs.push(cwd);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  const base = relative(REPO_ROOT, cwd);
  return { cwd, id: (file, name) => (name === undefined ? `${base}/${file}` : `${base}/${file} > ${name}`) };
}

function entry(test: string, expires: string = addDays(TODAY, 14)): LoadedEntry {
  return { test, issue: 1, owner: 'test', reason: 'test', added: TODAY, expires, renewals: [], file: entryFileName(test) };
}

const FLAKY = `import { describe, expect, test } from 'bun:test';
describe('flaky', () => { test('fails', () => { expect(1).toBe(2); }); });
test('passes', () => {});
`;
const OTHER_FAILURE = `import { test } from 'bun:test';
test('also fails', () => { throw new Error('real'); });
`;
const LOAD_ERROR = `import './missing-module';
`;
const BROKEN_HOOK = `import { beforeAll, describe, test } from 'bun:test';
describe('setup', () => { beforeAll(() => { throw new Error('hook broke'); }); test('never', () => {}); });
`;

const TWO_HOOKS = `import { beforeAll, describe, expect, test } from 'bun:test';
describe('flaky setup', () => { beforeAll(() => { throw new Error('flaky'); }); test('a', () => {}); });
describe('real regression', () => { beforeAll(() => { throw new Error('always'); }); test('important', () => { expect(1).toBe(1); }); });
`;
const DUPLICATE_NAMES = `import { describe, expect, test } from 'bun:test';
describe('d', () => {
  test('works', () => { throw new Error('the flake'); });
  test('works', () => { expect('regression').toBe('fixed'); });
});
`;
const EACH_SAME_NAME = `import { expect, test } from 'bun:test';
test.each([1, 2, 3])('handles input', (n) => { expect(n).toBe(0); });
`;
const NESTING_COLLISION = `import { describe, test } from 'bun:test';
describe('d', () => { describe('same', () => { test('x', () => { throw new Error('flake'); }); }); });
describe('d > same', () => { test('x', () => { throw new Error('regression'); }); });
`;
const RETRIED_FLAKE = `import { test } from 'bun:test';
let attempts = 0;
test('flaky with retry', () => { attempts += 1; if (attempts === 1) throw new Error('flake'); }, { retry: 2 });
test('other', () => { throw new Error('quarantined elsewhere'); });
`;

async function exitCode(cwd: string, entries: LoadedEntry[]): Promise<number> {
  const verdict = await runBunTestVerdict({ cwd, args: ['./'], suite: 'test', entries, today: TODAY, forward: () => {}, env: {}, quarantine: true });
  return verdict.exitCode;
}

describe('the quarantine runner on real bun test runs', () => {
  test('a run whose only failure is quarantined exits 0', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY });
    expect(await exitCode(run.cwd, [entry(run.id('flaky.test.ts', 'flaky > fails'))])).toBe(0);
  });

  test('the same run with no entry exits 1', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY });
    expect(await exitCode(run.cwd, [])).toBe(1);
  });

  test('a failure no entry covers keeps exit code 1', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY, 'other.test.ts': OTHER_FAILURE });
    expect(await exitCode(run.cwd, [entry(run.id('flaky.test.ts', 'flaky > fails'))])).toBe(1);
  });

  test('a file that fails to load, which JUnit leaves out, keeps exit code 1', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY, 'load.test.ts': LOAD_ERROR });
    expect(await exitCode(run.cwd, [entry(run.id('flaky.test.ts', 'flaky > fails'))])).toBe(1);
  });

  test('an expired entry keeps exit code 1', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY });
    expect(await exitCode(run.cwd, [entry(run.id('flaky.test.ts', 'flaky > fails'), '2026-10-28')])).toBe(1);
  });

  test('an unnamed entry forgives its own describe\'s hook failure', async () => {
    const hook = suite({ 'hook.test.ts': BROKEN_HOOK });
    expect(await exitCode(hook.cwd, [entry(hook.id('hook.test.ts', 'setup > (unnamed)'))])).toBe(0);
  });

  // Regressions from the review of #1663: each of these exited 0 before.
  test('an unnamed entry for one describe\'s hook does not forgive another describe\'s broken hook', async () => {
    const run = suite({ 'hooks.test.ts': TWO_HOOKS });
    expect(await exitCode(run.cwd, [entry(run.id('hooks.test.ts', 'flaky setup > (unnamed)'))])).toBe(1);
  });

  test('a file-level unnamed entry does not forgive a describe\'s broken hook', async () => {
    const run = suite({ 'hooks.test.ts': TWO_HOOKS });
    expect(await exitCode(run.cwd, [entry(run.id('hooks.test.ts', '(unnamed)'))])).toBe(1);
  });

  test('two tests with one name forgive neither', async () => {
    const run = suite({ 'dup.test.ts': DUPLICATE_NAMES });
    expect(await exitCode(run.cwd, [entry(run.id('dup.test.ts', 'd > works'))])).toBe(1);
  });

  test('test.each cases that share a name forgive none', async () => {
    const run = suite({ 'each.test.ts': EACH_SAME_NAME });
    expect(await exitCode(run.cwd, [entry(run.id('each.test.ts', 'handles input'))])).toBe(1);
  });

  test('a describe named "d > same" beside describe d > same forgives neither', async () => {
    const run = suite({ 'gt.test.ts': NESTING_COLLISION });
    expect(await exitCode(run.cwd, [entry(run.id('gt.test.ts', 'd > same > x'))])).toBe(1);
  });

  test('a quarantined test that passes on retry reports passed; a load error beside it still blocks', async () => {
    const run = suite({ 'retry.test.ts': RETRIED_FLAKE });
    const entries = [entry(run.id('retry.test.ts', 'flaky with retry')), entry(run.id('retry.test.ts', 'other'))];
    const verdict = await runBunTestVerdict({ cwd: run.cwd, args: ['./'], suite: 'test', entries, today: TODAY, forward: () => {}, env: {}, quarantine: true });
    expect(verdict.exitCode).toBe(0);
    expect(verdict.outcomes.map((outcome) => outcome.outcome)).toEqual(['passed', 'failed']);
    const broken = suite({ 'retry.test.ts': RETRIED_FLAKE, 'broken.test.ts': LOAD_ERROR });
    const brokenEntries = [entry(broken.id('retry.test.ts', 'flaky with retry')), entry(broken.id('retry.test.ts', 'other'))];
    expect(await exitCode(broken.cwd, brokenEntries)).toBe(1);
  });

  test('without --quarantine the runner is plain bun test and forgives nothing', async () => {
    const run = suite({ 'flaky.test.ts': FLAKY });
    const entries = [entry(run.id('flaky.test.ts', 'flaky > fails'))];
    expect(await runBunTest({ cwd: run.cwd, args: ['./'], suite: 'test', entries, today: TODAY, forward: () => {}, env: {}, quarantine: false })).toBe(1);
  });

  test('no .env file can turn quarantine on: a bun child that loads every old switch variable still fails', () => {
    // bun loads these files from its working directory into process.env.
    const switches = [
      'PYRIC_QUARANTINE=1', 'GITHUB_EVENT_NAME=push', 'GITHUB_REF=refs/heads/main',
      'PYRIC_QUARANTINE_BASE_ENTRIES=[]', '',
    ].join('\n');
    const run = suite({ 'flaky.test.ts': FLAKY, '.env': switches, '.env.local': switches, '.env.development': switches, 'drive.ts': '' });
    const entries = [entry(run.id('flaky.test.ts', 'flaky > fails'))];
    const drive = [
      `const { main } = await import(${JSON.stringify(join(REPO_ROOT, 'scripts/ci/quarantine-test.ts'))});`,
      `console.log('switch', process.env.PYRIC_QUARANTINE, process.env.GITHUB_REF);`,
      `process.exit(await main([...process.argv.slice(2), '--cwd', ${JSON.stringify(run.cwd)}, '--suite', 'env'], ${JSON.stringify(entries)}));`,
      '',
    ].join('\n');
    writeFileSync(join(run.cwd, 'drive.ts'), drive);
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    const plain = Bun.spawnSync(['bun', 'drive.ts'], { cwd: run.cwd, env, stdout: 'pipe', stderr: 'pipe' });
    expect(plain.stdout.toString()).toContain('switch 1 refs/heads/main');
    expect(plain.exitCode).toBe(1);
    // The control: the same child with the flag forgives the quarantined failure.
    const flagged = Bun.spawnSync(['bun', 'drive.ts', '--quarantine'], { cwd: run.cwd, env, stdout: 'pipe', stderr: 'pipe' });
    expect(flagged.exitCode).toBe(0);
  });

  test('a passing run exits 0', async () => {
    const run = suite({ 'pass.test.ts': 'import { test } from \'bun:test\';\ntest(\'ok\', () => {});\n' });
    expect(await exitCode(run.cwd, [])).toBe(0);
  });
});
