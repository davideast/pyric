import { describe, expect, test } from 'bun:test';
import {
  formatSourceAtLine,
  splitSourceLocation,
} from '../../../src/assurance-surface/passes/source-location.js';

describe('source-location helpers', () => {
  test('splits valid file:line locations and leaves malformed or Windows drive colons intact', () => {
    expect(splitSourceLocation('src/queries.ts:42')).toEqual({
      file: 'src/queries.ts',
      line: 42,
    });
    expect(splitSourceLocation('src/queries.ts')).toEqual({
      file: 'src/queries.ts',
      line: undefined,
    });
    expect(splitSourceLocation('src/queries.ts:0')).toEqual({
      file: 'src/queries.ts',
      line: undefined,
    });
    expect(splitSourceLocation('src/queries.ts:notanumber')).toEqual({
      file: 'src/queries.ts',
      line: undefined,
    });
    expect(splitSourceLocation(':12')).toEqual({
      file: ':12',
      line: undefined,
    });
  });

  test('formats optional line suffix cleanly', () => {
    expect(formatSourceAtLine(undefined)).toBe('');
    expect(formatSourceAtLine(15)).toBe(' at line 15');
  });
});
