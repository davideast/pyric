// Runs real `bun test` processes on small suites written to a temporary
// directory, through the quarantine runner, and checks the exit code each ends
// with. No browser and no network.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { REPO_ROOT, addDays, entryFileName, type LoadedEntry } from './entries.ts';
import { runBunTestVerdict } from './run-bun-test.ts';

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

async function exitCode(cwd: string, entries: LoadedEntry[]): Promise<number> {
  const verdict = await runBunTestVerdict({ cwd, args: ['./'], suite: 'test', entries, today: TODAY, forward: () => {}, env: {} });
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

  test('a file entry forgives the file\'s unnamed hook failure, but not a named failure', async () => {
    const hook = suite({ 'hook.test.ts': BROKEN_HOOK });
    expect(await exitCode(hook.cwd, [entry(hook.id('hook.test.ts'))])).toBe(0);
    const named = suite({ 'flaky.test.ts': FLAKY });
    expect(await exitCode(named.cwd, [entry(named.id('flaky.test.ts'))])).toBe(1);
  });

  test('a passing run exits 0', async () => {
    const run = suite({ 'pass.test.ts': 'import { test } from \'bun:test\';\ntest(\'ok\', () => {});\n' });
    expect(await exitCode(run.cwd, [])).toBe(0);
  });
});
