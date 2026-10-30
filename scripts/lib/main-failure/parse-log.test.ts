import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { checkoutResolver, namedFailedJobs, parseFailures } from './parse-log.ts';
import { ASSERTION_LOG, HOOK_TIMEOUT_LOG, PACKAGING_LOG, SPARSE, TESTS_JOB, hookTimeout } from './test-fixtures.ts';

const ROOT = resolve(import.meta.dir, '../../..');

describe('reading the failures from a job log', () => {
  test('a hook timeout names the file and the note bun printed after it', () => {
    expect(parseFailures(TESTS_JOB, HOOK_TIMEOUT_LOG)).toEqual([hookTimeout]);
  });

  test('a failed assertion names the file, the test, the error line and where it was thrown', () => {
    expect(parseFailures('App scenarios', ASSERTION_LOG)).toEqual([{
      job: 'App scenarios',
      test: 'test/apps/unreaped-exit.test.ts > reading an unreaped exit from /proc > a running process has no exit, and a zombie has its own',
      assertion: 'error: expect(received).toEqual(expected) (at test/apps/unreaped-exit.test.ts:57:43)',
    }]);
  });

  test('a log that names no test falls back to the job and its last error', () => {
    expect(parseFailures('Packaging gate', PACKAGING_LOG)).toEqual([{
      job: 'Packaging gate',
      assertion: 'Error: packed @pyric/cli Firebase SDK import edges drifted (at scripts/audit-packed-cli.mjs:118:9)',
    }]);
  });

  test('a log with no error at all falls back to the Actions annotation', () => {
    expect(parseFailures('Lint', '##[error]Process completed with exit code 2.')).toEqual([
      { job: 'Lint', assertion: 'Process completed with exit code 2.' },
    ]);
  });

  test('colour codes do not hide a failure', () => {
    expect(parseFailures(TESTS_JOB, HOOK_TIMEOUT_LOG.replace('(fail)', '\u001b[31m(fail)\u001b[0m'))).toEqual([hookTimeout]);
  });

  test('an error a passing test printed is not the assertion of the next failure', () => {
    const log = [
      '##[group]test/a.test.ts:',
      'Error: noise a passing test logged',
      '(pass) a > logs noise',
      '(fail) a > times out in a hook [5000.00ms]',
      '  ^ a beforeEach/afterEach hook timed out for this test.',
      '##[endgroup]',
    ].join('\n');
    expect(parseFailures('job', log)).toEqual([
      { job: 'job', test: 'test/a.test.ts > a > times out in a hook', assertion: 'a beforeEach/afterEach hook timed out for this test.' },
    ]);
  });

  test('a failure after a group closes is not credited to that group\'s file', () => {
    const log = ['##[group]test/a.test.ts:', '(pass) a > passes', '##[endgroup]', '(fail) loose > fails'].join('\n');
    expect(parseFailures('job', log)).toEqual([{ job: 'job', test: 'loose > fails' }]);
  });

  test('a test that fails twice in one log keeps its first failure', () => {
    const log = [
      '##[group]test/a.test.ts:',
      'error: first',
      '(fail) a > fails',
      '##[endgroup]',
      '##[group]test/a.test.ts:',
      'error: second',
      '(fail) a > fails',
      '##[endgroup]',
    ].join('\n');
    expect(parseFailures('job', log)).toEqual([{ job: 'job', test: 'test/a.test.ts > a > fails', assertion: 'error: first' }]);
  });

  test('a test path is placed in the package directory that holds it', () => {
    const resolveFile = (file: string) => `packages/cli/${file}`;
    expect(parseFailures(TESTS_JOB, HOOK_TIMEOUT_LOG, resolveFile)).toEqual([{ ...hookTimeout, test: `packages/cli/${SPARSE}` }]);
  });

  test('the checkout resolver finds the one directory that holds a path, and leaves the rest alone', () => {
    const resolveFile = checkoutResolver(ROOT);
    expect(resolveFile('test/serve/worker/client/rtdb-sparse-array-holes.test.ts'))
      .toBe('packages/cli/test/serve/worker/client/rtdb-sparse-array-holes.test.ts');
    expect(resolveFile('test/apps/unreaped-exit.test.ts')).toBe('test/apps/unreaped-exit.test.ts');
    expect(resolveFile('test/no-such-file.test.ts')).toBe('test/no-such-file.test.ts');
  });

  test('the summary job drops out when another job failed, and stays when it is the only one', () => {
    expect(namedFailedJobs([TESTS_JOB, 'CI / required'])).toEqual([TESTS_JOB]);
    expect(namedFailedJobs(['CI / required'])).toEqual(['CI / required']);
  });
});
