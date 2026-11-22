/**
 * Regression tests for `#1381` (Ledger A10): sign-out deletes only the
 * signed-out `(tenantId, uid)` entry from `tokenCache`, leaving cached tokens
 * for sibling tenants holding the same `uid` intact.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAuth,
  signInAnonymously,
  signOut,
} from '../../src/auth/index.js';
import { targetOf } from '../../src/auth/target.js';

describe('multi-tenant sign-out tokenCache isolation (#1381)', () => {
  it('deletes only the signed-out tenant token while preserving another tenant holding the same uid', async () => {
    const sandbox = initializeSandbox();
    try {
      const auth = getAuth(sandbox);
      auth.tenantId = 'tenant-a';
      const { user: userA } = await signInAnonymously(auth);
      const tokenABefore = await userA.getIdToken(false);

      const backend = targetOf(auth).backend;
      const tokenBBefore = backend.getIdTokenFor(userA.uid, {}, false, 'tenant-b');
      const tokenRootBefore = backend.getIdTokenFor(userA.uid, {}, false, null);

      expect(tokenBBefore).not.toBe(tokenABefore);
      expect(tokenRootBefore).not.toBe(tokenABefore);

      await signOut(auth);

      // Sibling tenants keep their exact cached tokens without silent rotation.
      expect(backend.getIdTokenFor(userA.uid, {}, false, 'tenant-b')).toBe(tokenBBefore);
      expect(backend.getIdTokenFor(userA.uid, {}, false, null)).toBe(tokenRootBefore);

      // The signed-out tenant's cached token was dropped, so reading it mints a new token.
      expect(backend.getIdTokenFor(userA.uid, {}, false, 'tenant-a')).not.toBe(tokenABefore);
    } finally {
      sandbox.dispose();
    }
  });

  it('preserves a tenanted token when the project-level (null tenant) session for the same uid signs out', async () => {
    const sandbox = initializeSandbox();
    try {
      const auth = getAuth(sandbox);
      const { user: rootUser } = await signInAnonymously(auth);
      const tokenRootBefore = await rootUser.getIdToken(false);

      const backend = targetOf(auth).backend;
      const tokenAlphaBefore = backend.getIdTokenFor(rootUser.uid, {}, false, 'tenant-alpha');

      await signOut(auth);

      expect(backend.getIdTokenFor(rootUser.uid, {}, false, 'tenant-alpha')).toBe(tokenAlphaBefore);
      expect(backend.getIdTokenFor(rootUser.uid, {}, false, null)).not.toBe(tokenRootBefore);
    } finally {
      sandbox.dispose();
    }
  });
});
