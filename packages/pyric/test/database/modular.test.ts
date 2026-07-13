/**
 * Package resolution is the only production/sandbox selection seam.
 * A direct pyric/database import must never adapt or dispatch to a real
 * Firebase app at runtime.
 */
import { describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from 'firebase/app';
import { getAdminDatabase, getDatabase } from '../../src/database/index.js';

const config = {
  apiKey: 'fake-api-key',
  authDomain: 'pyric-database-package-resolution.firebaseapp.com',
  databaseURL: 'https://pyric-database-package-resolution.firebaseio.com',
  projectId: 'pyric-database-package-resolution',
  appId: '1:0:web:0',
};

describe('database modular mirror package-resolution boundary', () => {
  it('rejects real Firebase apps instead of dispatching to firebase/database', async () => {
    const app = initializeApp(config, `package-resolution-${Math.random()}`);
    try {
      expect(() => getDatabase(app as never)).toThrow(
        /sandbox-only mirror.*Package resolution/s,
      );
    } finally {
      await deleteApp(app);
    }
  });

  it('rejects real Firebase apps at the sandbox owner entry too', async () => {
    const app = initializeApp(config, `admin-package-resolution-${Math.random()}`);
    try {
      expect(() => getAdminDatabase(app as never)).toThrow(
        /sandbox-only mirror.*Package resolution/s,
      );
    } finally {
      await deleteApp(app);
    }
  });
});
