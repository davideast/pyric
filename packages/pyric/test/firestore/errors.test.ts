import { describe, expect, it } from 'bun:test';
import { FirebaseError } from '../../src/sandbox/internal/firebase-error.js';
import {
  toFirestoreFirebaseError,
  withFirestoreFirebaseError,
} from '../../src/firestore/errors.js';

describe('Firestore modular error translation', () => {
  it('passes through FirebaseError and non-coded values unchanged', () => {
    const firebase = new FirebaseError('permission-denied', 'denied');
    const plain = new Error('plain');
    expect(toFirestoreFirebaseError(firebase)).toBe(firebase);
    expect(toFirestoreFirebaseError(plain)).toBe(plain);
  });

  it('preserves sandbox diagnostics on both the public error and customData', () => {
    const denialContext = { request: { method: 'create', path: 'locked/x' } };
    const source = Object.assign(new Error('denied'), {
      code: 'permission-denied',
      denialContext,
      remediation: 'sign in',
    });

    const translated = toFirestoreFirebaseError(source) as FirebaseError & {
      denialContext?: unknown;
      remediation?: unknown;
    };
    expect(translated).toBeInstanceOf(FirebaseError);
    expect(translated.code).toBe('permission-denied');
    expect(translated.denialContext).toBe(denialContext);
    expect(translated.remediation).toBe('sign in');
    expect(translated.customData).toEqual({ denialContext, remediation: 'sign in' });
  });

  it('rethrows a coded rejection as a FirebaseError', async () => {
    const source = Object.assign(new Error('missing'), { code: 'not-found' });
    await expect(withFirestoreFirebaseError(async () => { throw source; }))
      .rejects.toBeInstanceOf(FirebaseError);
  });
});
