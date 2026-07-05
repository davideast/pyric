import { describe, test, expect } from 'bun:test';
import { WriteRulesErrorCode } from '../../../src/database/write/spec.js';

describe('WriteRulesErrorCode', () => {
  test('contains WRITE_FAILED', () => {
    expect(WriteRulesErrorCode.enum.WRITE_FAILED).toBe('WRITE_FAILED');
  });

  test('contains PERMISSION_DENIED', () => {
    expect(WriteRulesErrorCode.enum.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
  });

  test('contains INVALID_RULES_JSON', () => {
    expect(WriteRulesErrorCode.enum.INVALID_RULES_JSON).toBe('INVALID_RULES_JSON');
  });

  test('has exactly 3 values', () => {
    expect(WriteRulesErrorCode.options).toHaveLength(3);
  });
});
