import { describe, test, expect } from 'bun:test';
import { lintExpression } from '../../../../src/rules/rtdb/grammar/linter.js';

describe('06-rtdb-linter-tautological-public-access', () => {
  test('flags literal identity equality as HARDCODED_TRUE', () => {
    const warningsNum = lintExpression('1 == 1', 'read');
    expect(warningsNum.map(w => w.code)).toContain('HARDCODED_TRUE');

    const warningsStr = lintExpression('"a" == "a"', 'read');
    expect(warningsStr.map(w => w.code)).toContain('HARDCODED_TRUE');
  });

  test('flags literal inequality of identical values as HARDCODED_FALSE', () => {
    const warningsNum = lintExpression('1 != 1', 'read');
    expect(warningsNum.map(w => w.code)).toContain('HARDCODED_FALSE');
  });
});
