import { describe, expect, test } from 'bun:test';
import { readCounts } from './counts.ts';

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
    expect(readCounts(log)).toEqual({ tests: 754, files: 93, pass: 745, fail: 2, skip: 6, todo: 1 });
  });

  test('node --test summaries count too, in spec and in TAP form', () => {
    const spec = ['ℹ tests 8', 'ℹ suites 0', 'ℹ pass 7', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 0'].join('\n');
    const tap = ['# tests 3', '# pass 2', '# fail 1', '# skipped 0', '# todo 0'].join('\n');
    expect(readCounts(`${spec}\n${tap}`)).toEqual({ tests: 11, files: 0, pass: 9, fail: 1, skip: 1, todo: 0 });
  });

  test('a log with no summary counts nothing', () => {
    expect(readCounts('$ tsc --noEmit\n')).toEqual({ tests: 0, files: 0, pass: 0, fail: 0, skip: 0, todo: 0 });
  });
});
