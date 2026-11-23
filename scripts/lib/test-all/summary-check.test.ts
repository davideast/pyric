import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from '../private-job-tmpdir.ts';
import { emptyCounts } from './counts.ts';
import type { TestJob } from './plan.ts';
import { summaryProblem } from './summary-check.ts';

const testAllEntry = fileURLToPath(new URL('../../test-all.ts', import.meta.url));
const scratchCheckouts: string[] = [];

afterEach(() => {
  while (scratchCheckouts.length > 0) {
    const dir = scratchCheckouts.pop();
    if (dir !== undefined) {
      removePrivateJobTmpDir(dir);
    }
  }
});

const shard: TestJob = {
  name: 'cli 1/6',
  command: 'bun',
  args: ['test', './a.test.ts', './b.test.ts'],
  cwd: '/repo/packages/cli',
  runsBunTest: true,
  expectedFiles: 2,
};

describe('a bun test job that did not run every file or crashed at load (#1207)', () => {
  test('a job that ran all its files passes the check', () => {
    expect(summaryProblem(shard, { ...emptyCounts(), tests: 9, files: 2, pass: 9 })).toBeUndefined();
  });

  test('a job with no summary, as when a test file calls process.exit(0), fails it', () => {
    expect(summaryProblem(shard, emptyCounts())).toContain('printed no "Ran N tests across M files" summary');
  });

  test('a job whose summary counts fewer files than it was given fails it', () => {
    expect(summaryProblem(shard, { ...emptyCounts(), tests: 4, files: 1, pass: 4 })).toBe(
      'cli 1/6 ran 1 of its 2 test files',
    );
  });

  test('a job that reported unhandled errors outside tests (0 fail, 1 error) fails it', () => {
    expect(summaryProblem(shard, { ...emptyCounts(), tests: 4, files: 2, pass: 4, errors: 1 })).toBe(
      'cli 1/6 reported 1 unhandled error(s) outside tests',
    );
  });

  test('a job where a *.test.* file registered 0 tests fails it even when exit code was 0', () => {
    expect(
      summaryProblem(shard, {
        ...emptyCounts(),
        tests: 4,
        files: 2,
        pass: 4,
        emptyTestFiles: ['b.test.ts'],
      }),
    ).toBe('cli 1/6 had test file(s) register 0 tests: b.test.ts');
  });

  test('a job that is not bun test is not checked', () => {
    expect(
      summaryProblem(
        { ...shard, name: 'ui', command: 'bun', args: ['run', 'test'], runsBunTest: false },
        emptyCounts(),
      ),
    ).toBeUndefined();
  });

  test('real test-all run fails when a test file crashes before registering tests despite bun test exiting 0 (#1207)', () => {
    const root = createPrivateJobTmpDir('test-all-crash-ut');
    scratchCheckouts.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:serial': 'bun test' } }));
    writeFileSync(
      join(root, 'ok.test.ts'),
      "import { expect, test } from 'bun:test';\ntest('passes', () => { expect(1).toBe(1); });\n",
    );
    writeFileSync(
      join(root, 'crash-before-registering.test.ts'),
      "setTimeout(() => { throw new Error('crash before tests register'); }, 0);\n",
    );
    const run = spawnSync(
      process.execPath,
      [testAllEntry, `--root=${root}`, '--jobs=1'],
      {
        cwd: root,
        env: { ...process.env, PYRIC_HEAVY_RUN_DIR: join(root, '.heavy-runs') },
        encoding: 'utf8',
      },
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('crash-before-registering.test.ts');
  });

  test('real test-all run surfaces unhandled load/describe errors in counts instead of reporting only 0 fail (#1207)', () => {
    const root = createPrivateJobTmpDir('test-all-describe-err-ut');
    scratchCheckouts.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:serial': 'bun test' } }));
    writeFileSync(
      join(root, 'ok.test.ts'),
      "import { expect, test } from 'bun:test';\ntest('passes', () => { expect(1).toBe(1); });\n",
    );
    writeFileSync(
      join(root, 'describe-throw.test.ts'),
      "import { describe, test } from 'bun:test';\ndescribe('broken', () => { throw new Error('boom'); test('x', () => {}); });\n",
    );
    const run = spawnSync(
      process.execPath,
      [testAllEntry, `--root=${root}`, '--jobs=1'],
      {
        cwd: root,
        env: { ...process.env, PYRIC_HEAVY_RUN_DIR: join(root, '.heavy-runs') },
        encoding: 'utf8',
      },
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('1 error');
    expect(run.stdout).toContain('reported 1 unhandled error(s) outside tests');
  });
});
