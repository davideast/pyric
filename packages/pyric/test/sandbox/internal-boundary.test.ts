import { describe, expect, it } from 'bun:test';
import * as firestoreInternal from 'pyric/firestore/internal';
import * as sandboxInternal from '../../src/sandbox/internal/index.js';

describe('sandbox internal ownership boundary', () => {
  it('does not publish Firestore-only listener routing state', () => {
    expect('FOLLOWS_CURRENT_USER' in sandboxInternal).toBe(false);
    expect('AUTH_SESSION_SCOPE' in sandboxInternal).toBe(false);
    expect(typeof firestoreInternal.FOLLOWS_CURRENT_USER).toBe('symbol');
    expect(typeof firestoreInternal.AUTH_SESSION_SCOPE).toBe('symbol');
  });
});
