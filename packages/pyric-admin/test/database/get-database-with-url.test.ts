import { afterEach, describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  deleteApp,
  getApps,
  initializeApp,
} from '../../src/app/index.js';
import {
  getDatabase,
  getDatabaseWithUrl,
} from '../../src/database/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('getDatabaseWithUrl', () => {
  test('accepts the upstream url-first signature and selects the supplied app database', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() });

    const database = getDatabaseWithUrl(
      'https://demo-project-default-rtdb.firebaseio.com',
      app,
    );
    await database.ref('functions/created').set({ value: 42 });

    expect((await getDatabase(app).ref('functions/created').get()).val()).toEqual({
      value: 42,
    });
  });
});
