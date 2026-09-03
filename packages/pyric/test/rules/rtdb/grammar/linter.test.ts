import { describe, test, expect } from 'bun:test';
import { lintExpression } from '../../../../src/rules/rtdb/grammar/linter.js';

describe('lintExpression', () => {
  test('no warnings for standard equality', () => {
    const warnings = lintExpression('auth.uid == "abc"', 'read');
    expect(warnings.filter(w => w.code === 'LOOSE_EQUALITY')).toHaveLength(0);
  });

  test('no LOOSE_EQUALITY warning for ==', () => {
    const warnings = lintExpression('auth.uid == "abc"', 'read');
    const codes = warnings.map(w => w.code);
    expect(codes).not.toContain('LOOSE_EQUALITY');
  });

  test('no LOOSE_INEQUALITY warning for !=', () => {
    const warnings = lintExpression('auth != null != false', 'read');
    const warnings2 = lintExpression('auth.uid != null', 'read');
    expect(warnings2.map(w => w.code)).not.toContain('LOOSE_INEQUALITY');
  });

  test('HARDCODED_TRUE warning for literal true expression', () => {
    const warnings = lintExpression('true', 'read');
    expect(warnings.map(w => w.code)).toContain('HARDCODED_TRUE');
  });

  test('HARDCODED_FALSE warning for literal false expression', () => {
    const warnings = lintExpression('false', 'write');
    expect(warnings.map(w => w.code)).toContain('HARDCODED_FALSE');
  });

  test('DATA_IN_WRITE when write rule has data but not newData', () => {
    const warnings = lintExpression('data.exists()', 'write');
    expect(warnings.map(w => w.code)).toContain('DATA_IN_WRITE');
  });

  test('no DATA_IN_WRITE when write rule has both data and newData', () => {
    const warnings = lintExpression('data.exists() && newData.exists()', 'write');
    expect(warnings.filter(w => w.code === 'DATA_IN_WRITE')).toHaveLength(0);
  });

  test('no DATA_IN_WRITE for read context', () => {
    const warnings = lintExpression('data.exists()', 'read');
    expect(warnings.filter(w => w.code === 'DATA_IN_WRITE')).toHaveLength(0);
  });

  test('returns empty array for invalid expression', () => {
    const warnings = lintExpression('auth ===', 'read');
    expect(warnings).toHaveLength(0);
  });

  test('no warnings for clean expression', () => {
    const warnings = lintExpression('auth != null && newData.exists()', 'write');
    expect(warnings).toHaveLength(0);
  });

  test('no DATA_IN_WRITE when data.child() is used for comparison', () => {
    const warnings = lintExpression(
      'auth != null && (data.child("lastWrite").val() == null || now - data.child("lastWrite").val() > 60000)',
      'write',
    );
    expect(warnings.filter(w => w.code === 'DATA_IN_WRITE')).toHaveLength(0);
  });

  test('DATA_IN_WRITE still fires for data.exists() without child access', () => {
    const warnings = lintExpression('data.exists()', 'write');
    expect(warnings.map(w => w.code)).toContain('DATA_IN_WRITE');
  });
});
