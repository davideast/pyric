import { describe, expect, test } from 'bun:test';
import { FirestoreCompatError } from '../../../src/firestore/sandbox/firestore-compat-error.js';

describe('FirestoreCompatError', () => {
  test('preserves Firebase error identity and simulator context', () => {
    const simError = { code: 'invalid-argument' as const, message: 'bad query' };
    const error = new FirestoreCompatError(simError);

    expect(error.name).toBe('FirestoreError');
    expect(error.code).toBe('invalid-argument');
    expect(error.simError).toBe(simError);
  });
});
