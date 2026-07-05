import { describe, test, expect } from 'bun:test';
import { DataErrorCode } from '../../../src/database/data/spec.js';

describe('DataErrorCode', () => {
  test('has exactly 4 values', () => {
    expect(DataErrorCode.options).toHaveLength(4);
  });

  test('contains expected codes', () => {
    expect(DataErrorCode.enum.READ_FAILED).toBe('READ_FAILED');
    expect(DataErrorCode.enum.WRITE_FAILED).toBe('WRITE_FAILED');
    expect(DataErrorCode.enum.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
    expect(DataErrorCode.enum.NOT_FOUND).toBe('NOT_FOUND');
  });
});
