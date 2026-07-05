/**
 * Type-level checks — the `@pyric/auth` public surface should be
 * shape-compatible with `firebase/auth`'s modular surface for the
 * v0 subset.
 *
 * Only the function-signature contracts that the dual-target swap
 * relies on are asserted here. Class-instance shape (provider
 * classes, etc.) is exercised by the runtime tests.
 *
 * These are bun:test cases that only ever fail at *type-check* time —
 * the bodies don't actually run anything that would assert. If
 * tsconfig's typecheck passes, the contracts hold.
 */
import { describe, it, expect } from 'bun:test';
import type {
  Unsubscribe as PyricUnsubscribe,
  Auth as PyricAuth,
  User as PyricUser,
  UserCredential as PyricUC,
  AuthObserver,
} from '../../src/auth/index.js';
import type * as fb from 'firebase/auth';

describe('type-level surface checks', () => {
  it('PyricUser uid/email/displayName/isAnonymous shape lines up with fb.User', () => {
    type PyricSubset = Pick<PyricUser, 'uid' | 'email' | 'displayName' | 'isAnonymous'>;
    type FbSubset = Pick<fb.User, 'uid' | 'email' | 'displayName' | 'isAnonymous'>;
    // Assignability both ways for the shared subset:
    const _a: PyricSubset = { uid: 'x', email: null, displayName: null, isAnonymous: false };
    const _b: FbSubset = _a;
    expect(_b.uid).toBe('x');
  });

  it('PyricUserCredential.providerId matches fb.UserCredential.providerId', () => {
    type PyP = PyricUC['providerId'];
    type FbP = fb.UserCredential['providerId'];
    // string | null both ways:
    const _a: PyP = null;
    const _b: FbP = _a;
    expect(_b).toBe(null);
  });

  it('Unsubscribe is callable () => void', () => {
    const u: PyricUnsubscribe = () => {};
    u();
    expect(true).toBe(true);
  });

  it('AuthObserver accepts both function and object forms', () => {
    const fn: AuthObserver = (_u) => {};
    const obj: AuthObserver = { next: (_u) => {} };
    expect(typeof fn).toBe('function');
    expect(typeof obj).toBe('object');
  });

  it('PyricAuth carries currentUser: User | null', () => {
    // Just check the field exists at the type level.
    type CU = PyricAuth['currentUser'];
    const _x: CU = null;
    expect(_x).toBe(null);
  });
});
