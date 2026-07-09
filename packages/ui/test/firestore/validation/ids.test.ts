import { describe, expect, test } from 'bun:test';
import { validateCollectionId, validateDocumentId } from '../../../src/firestore/validation/ids.js';

describe('validateCollectionId', () => {
  test('accepts an ordinary id', () => {
    expect(validateCollectionId('users')).toBeUndefined();
    expect(validateCollectionId('user_posts-2024')).toBeUndefined();
  });

  test('rejects empty', () => {
    expect(validateCollectionId('')).toBe('Cannot be empty');
  });

  test('rejects a slash', () => {
    expect(validateCollectionId('users/alice')).toBe('Cannot contain "/"');
  });

  test('rejects "." and ".."', () => {
    expect(validateCollectionId('.')).toBe('Cannot be "." or ".."');
    expect(validateCollectionId('..')).toBe('Cannot be "." or ".."');
  });

  test('rejects reserved __.*__ pattern', () => {
    expect(validateCollectionId('__reserved__')).toBe('Cannot match __.*__ (reserved)');
    expect(validateCollectionId('__x__')).toBe('Cannot match __.*__ (reserved)');
  });

  test('allows a leading/trailing single underscore (not the reserved pattern)', () => {
    expect(validateCollectionId('_private')).toBeUndefined();
    expect(validateCollectionId('private_')).toBeUndefined();
  });
});

describe('validateDocumentId', () => {
  test('accepts an ordinary id', () => {
    expect(validateDocumentId('alice')).toBeUndefined();
  });

  test('shares the structural rules with collection ids', () => {
    expect(validateDocumentId('')).toBe('Cannot be empty');
    expect(validateDocumentId('a/b')).toBe('Cannot contain "/"');
    expect(validateDocumentId('.')).toBe('Cannot be "." or ".."');
    expect(validateDocumentId('..')).toBe('Cannot be "." or ".."');
    expect(validateDocumentId('__x__')).toBe('Cannot match __.*__ (reserved)');
  });

  test('rejects an id over 1500 bytes', () => {
    const tooLong = 'a'.repeat(1501);
    expect(validateDocumentId(tooLong)).toBe('Cannot exceed 1500 bytes');
  });

  test('accepts an id right at the 1500-byte boundary', () => {
    const atLimit = 'a'.repeat(1500);
    expect(validateDocumentId(atLimit)).toBeUndefined();
  });

  test('measures multi-byte characters by UTF-8 bytes, not code units', () => {
    // Each '🔥' is 4 UTF-8 bytes but 2 UTF-16 code units.
    const emoji = '🔥'.repeat(374); // 374 * 4 = 1496 bytes, under the cap
    expect(validateDocumentId(emoji)).toBeUndefined();
    const tooManyEmoji = '🔥'.repeat(376); // 376 * 4 = 1504 bytes, over the cap
    expect(validateDocumentId(tooManyEmoji)).toBe('Cannot exceed 1500 bytes');
  });
});
