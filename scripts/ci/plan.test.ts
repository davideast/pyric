import { describe, expect, test } from 'bun:test';
import { parseNameStatus } from './plan.ts';

describe('CI change input', () => {
  test('preserves both sides of renames and ordinary changed paths', () => {
    expect(parseNameStatus('M\0README.md\0R100\0docs/old.md\0docs/new.md\0D\0gone.txt\0')).toEqual([
      { path: 'README.md' },
      { path: 'docs/new.md', previousPath: 'docs/old.md' },
      { path: 'gone.txt' },
    ]);
  });
});
