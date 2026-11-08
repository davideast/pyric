import { describe, expect, test } from 'bun:test';
import { errorMessage } from '../../src/rtdb/error-message.js';

describe('errorMessage', () => {
  test('extracts Error.message and stringifies non-Error values', () => {
    expect(errorMessage(new Error('invalid rules JSON'))).toBe('invalid rules JSON');
    expect(errorMessage('plain text failure')).toBe('plain text failure');
    expect(errorMessage(42)).toBe('42');
  });
});
