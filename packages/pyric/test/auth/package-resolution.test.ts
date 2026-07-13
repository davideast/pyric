/**
 * Package resolution is the only production/sandbox selection seam.
 * A direct pyric/auth import must never adapt or dispatch to a real
 * Firebase app at runtime.
 */
import { describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from 'firebase/app';
import { getAuth } from '../../src/auth/index.js';

const config = {
  apiKey: 'fake-api-key',
  authDomain: 'pyric-auth-package-resolution.firebaseapp.com',
  projectId: 'pyric-auth-package-resolution',
  appId: '1:0:web:0',
};

describe('pyric/auth package-resolution boundary', () => {
  it('rejects real Firebase apps instead of dispatching to firebase/auth', () => {
    const app = initializeApp(config, `package-resolution-${Math.random()}`);
    try {
      expect(() => getAuth(app as never)).toThrow(
        /sandbox-only mirror.*Package resolution/s,
      );
    } finally {
      void deleteApp(app);
    }
  });
});
