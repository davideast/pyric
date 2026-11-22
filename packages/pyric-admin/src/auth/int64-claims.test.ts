import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth as getClientAuth, signInWithCustomToken } from 'pyric/auth';
import { deleteApp, initializeApp } from '../app/index.js';
import { getAuth } from './index.js';

const POW53_PLUS_1 = 9007199254740993n;

describe('pyric-admin/auth int64 custom claims (#1817)', () => {
  test('preserves 2^53 + 1 through setCustomUserClaims, createCustomToken, UserRecord.toJSON, and verifyIdToken', async () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox }, `int64-claims-${Date.now()}`);
    try {
      const adminAuth = getAuth(app);
      const clientAuth = getClientAuth(sandbox);

      await adminAuth.createUser({ uid: 'alice' });
      await adminAuth.setCustomUserClaims('alice', { n: POW53_PLUS_1 });

      const userRecord = await adminAuth.getUser('alice');
      expect(userRecord.customClaims?.n).toBe(POW53_PLUS_1);
      expect(userRecord.toJSON().customClaims).toEqual({ n: POW53_PLUS_1 });

      const customToken = await adminAuth.createCustomToken('bob', { n: POW53_PLUS_1 });
      const cred = await signInWithCustomToken(clientAuth, customToken);
      const idToken = await cred.user.getIdToken();
      const decoded = await adminAuth.verifyIdToken(idToken);
      expect(decoded.n).toBe(POW53_PLUS_1);
    } finally {
      await deleteApp(app);
    }
  });
});
