import { expect, it } from 'bun:test';
import * as publicEntry from 'pyric/sandbox/admin-firestore';
import * as firestoreInternal from 'pyric/firestore/internal';

it('keeps modular listener-routing symbols behind the internal adapter seam', () => {
  expect('AUTH_SESSION_SCOPE' in publicEntry).toBe(false);
  expect('FOLLOWS_CURRENT_USER' in publicEntry).toBe(false);
  expect(typeof firestoreInternal.AUTH_SESSION_SCOPE).toBe('symbol');
  expect(typeof firestoreInternal.FOLLOWS_CURRENT_USER).toBe('symbol');
});
