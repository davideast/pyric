/**
 * Package resolution is the only production/sandbox selection seam.
 * A direct pyric/firestore import must never adapt or dispatch to a real
 * Firebase app at runtime.
 */
import { describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from 'firebase/app';
import { getFirestore } from '../../src/firestore/index.js';

const config = {
  apiKey: 'fake-api-key',
  authDomain: 'pyric-firestore-package-resolution.firebaseapp.com',
  projectId: 'pyric-firestore-package-resolution',
  appId: '1:0:web:0',
};

describe('pyric/firestore package-resolution boundary', () => {
  it('rejects real Firebase apps instead of dispatching to firebase/firestore', async () => {
    const app = initializeApp(config, `package-resolution-${Math.random()}`);
    try {
      expect(() => getFirestore(app as never)).toThrow(
        /sandbox-only mirror.*Package resolution/s,
      );
    } finally {
      await deleteApp(app);
    }
  });
});
