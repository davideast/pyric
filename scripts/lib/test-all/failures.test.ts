import { describe, expect, test } from 'bun:test';
import { failuresWithFiles } from './failures.ts';

describe('naming each failure with its file', () => {
  test('a failing test, an unnamed beforeAll failure and an unhandled error each name the file they ran in', () => {
    const output = [
      'test/serve/a.test.ts:',
      '(pass) a > works [1.00ms]',
      '(fail) a > breaks [2.00ms]',
      '',
      'test/serve/b.test.ts:',
      '(fail) (unnamed) [0.10ms]',
      '',
      'test/cli/c_test.tsx:',
      '# Unhandled error between tests',
      'error: boom',
    ].join('\n');
    expect(failuresWithFiles(output)).toEqual([
      'test/serve/a.test.ts: (fail) a > breaks [2.00ms]',
      'test/serve/b.test.ts: (fail) (unnamed) [0.10ms]',
      'test/cli/c_test.tsx: # Unhandled error between tests',
    ]);
  });

  test('a failure before any file header, and a node --test failure, are kept as printed', () => {
    expect(failuresWithFiles('(fail) setup [1.00ms]\n✖ a node test (2ms)\n')).toEqual(['(fail) setup [1.00ms]', '✖ a node test (2ms)']);
  });
});
