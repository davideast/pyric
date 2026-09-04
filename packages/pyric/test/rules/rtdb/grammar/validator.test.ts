import { describe, test, expect } from 'bun:test';
import { validateExpression } from '../../../../src/rules/rtdb/grammar/validator.js';

describe('validateExpression', () => {
  test('no errors for valid read expression', () => {
    const errors = validateExpression('auth != null', 'read');
    expect(errors).toHaveLength(0);
  });

  test('reports NEWDATA_IN_READ when newData used in read context', () => {
    const errors = validateExpression('newData.exists()', 'read');
    const codes = errors.map(e => e.code);
    expect(codes).toContain('NEWDATA_IN_READ');
  });

  test('no errors for newData in write context', () => {
    const errors = validateExpression('newData.exists()', 'write');
    expect(errors.filter(e => e.code === 'NEWDATA_IN_READ')).toHaveLength(0);
  });

  test('no errors for newData in validate context', () => {
    const errors = validateExpression('newData.val().matches(/^[a-z]+$/)', 'validate');
    expect(errors.filter(e => e.code === 'NEWDATA_IN_READ')).toHaveLength(0);
  });

  test('reports UNKNOWN_IDENTIFIER for unrecognized root identifier', () => {
    const errors = validateExpression('fooBar != null', 'read');
    const codes = errors.map(e => e.code);
    expect(codes).toContain('UNKNOWN_IDENTIFIER');
  });

  test('no error when path variable is in scope', () => {
    const errors = validateExpression('auth.uid == $userId', 'read', ['$userId']);
    // $userId starts with $ so is always valid
    expect(errors.filter(e => e.code === 'UNKNOWN_IDENTIFIER' && e.message.includes('$userId')))
      .toHaveLength(0);
  });

  test('reports UNKNOWN_METHOD for unknown DataSnapshot method', () => {
    const errors = validateExpression('data.unknownMethod()', 'read');
    const codes = errors.map(e => e.code);
    expect(codes).toContain('UNKNOWN_METHOD');
  });

  test('no error for known DataSnapshot methods', () => {
    const errors = validateExpression('data.val() != null', 'read');
    expect(errors.filter(e => e.code === 'UNKNOWN_METHOD')).toHaveLength(0);
  });

  test('no error for known string methods', () => {
    const errors = validateExpression('data.val().matches(/test/)', 'read');
    expect(errors.filter(e => e.code === 'UNKNOWN_METHOD')).toHaveLength(0);
  });

  test('returns empty array for invalid expression (parse failure)', () => {
    const errors = validateExpression('auth ===', 'read');
    expect(errors).toHaveLength(0);
  });
});
