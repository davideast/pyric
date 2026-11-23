import { describe, expect, test } from 'bun:test';
import { formatCounts, readCounts } from './counts.ts';

describe('the counts test-all reads from a job log', () => {
  test('bun test summaries are summed across every run in one log', () => {
    const log = [
      '(pass) a > b [1.00ms]',
      '',
      ' 735 pass',
      ' 6 skip',
      ' 0 fail',
      ' 4802 expect() calls',
      'Ran 741 tests across 92 files. [58.98s]',
      '$ bun test test/dom',
      ' 10 pass',
      ' 1 todo',
      ' 2 fail',
      'Ran 13 tests across 1 file. [1.00s]',
    ].join('\n');
    expect(readCounts(log)).toEqual({
      tests: 754,
      files: 93,
      pass: 745,
      fail: 2,
      errors: 0,
      skip: 6,
      todo: 1,
      emptyTestFiles: [],
    });
  });

  test('node --test summaries count too, in spec and in TAP form', () => {
    const spec = [
      '\u2139 tests 8',
      '\u2139 suites 0',
      '\u2139 pass 7',
      '\u2139 fail 0',
      '\u2139 cancelled 0',
      '\u2139 skipped 1',
      '\u2139 todo 0',
    ].join('\n');
    const tap = ['# tests 3', '# pass 2', '# fail 1', '# skipped 0', '# todo 0'].join('\n');
    expect(readCounts(`${spec}\n${tap}`)).toEqual({
      tests: 11,
      files: 0,
      pass: 9,
      fail: 1,
      errors: 0,
      skip: 1,
      todo: 0,
      emptyTestFiles: [],
    });
  });

  test('a log with no summary counts nothing', () => {
    expect(readCounts('$ tsc --noEmit\n')).toEqual({
      tests: 0,
      files: 0,
      pass: 0,
      fail: 0,
      errors: 0,
      skip: 0,
      todo: 0,
      emptyTestFiles: [],
    });
  });

  test('tracks unhandled error counts and *.test.* files that registered 0 tests (#1207)', () => {
    const log = [
      'test/ok.test.ts:',
      '(pass) ok [0.20ms]',
      '',
      'test/crashed-at-load.test.ts:',
      '',
      '# Unhandled error between tests',
      'error: boom',
      '',
      'src/rtdb/constraints/atoms.spec.ts:',
      '',
      ' 1 pass',
      ' 0 fail',
      ' 1 error',
      'Ran 1 test across 3 files. [0.05s]',
    ].join('\n');
    const counts = readCounts(log);
    expect(counts.errors).toBe(1);
    expect(counts.emptyTestFiles).toEqual(['test/crashed-at-load.test.ts']);
    expect(formatCounts(counts)).toContain(', 1 error');
  });
});
