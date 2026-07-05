/**
 * `getAuth(app)` prod-handle idempotency (AUTH-B6).
 *
 * Upstream `firebase/auth.getAuth(app)` returns the same `fb.Auth` per
 * app; our wrapper handle must be idempotent too. Before the fix it
 * minted a fresh wrapper per call (`getAuth(app) !== getAuth(app)`),
 * contradicting the `getAuth` docstring + COMPAT. Now memoized per
 * resolved `fb.Auth`.
 *
 * No network is required: `initializeApp` + `getAuth` only construct the
 * client handle; no auth operation is performed.
 */
import { describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from 'firebase/app';
import { getAuth } from '../../src/auth/index.js';

const config = {
  apiKey: 'fake-api-key',
  authDomain: 'pyric-auth-b6.firebaseapp.com',
  projectId: 'pyric-auth-b6',
  appId: '1:0:web:0',
};

describe('getAuth(app) prod-handle memoization (AUTH-B6)', () => {
  it('returns the SAME wrapper handle across repeat calls for one app', () => {
    const app = initializeApp(config, `b6-${Math.random()}`);
    try {
      const a = getAuth(app);
      const b = getAuth(app);
      expect(a).toBe(b);
    } finally {
      void deleteApp(app);
    }
  });

  it('distinct apps yield distinct handles', () => {
    const app1 = initializeApp(config, `b6a-${Math.random()}`);
    const app2 = initializeApp(config, `b6b-${Math.random()}`);
    try {
      expect(getAuth(app1)).not.toBe(getAuth(app2));
    } finally {
      void deleteApp(app1);
      void deleteApp(app2);
    }
  });
});
