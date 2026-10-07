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

// Production binds each URL to its own database instance. The admin sandbox
// has one tree per app, so every URL reads and writes that tree.
describe('database URL selection', () => {
  test('getDatabase(app, url) ignores the URL and shares the default tree', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() });

    await getDatabase(app, 'https://first.firebaseio.com').ref('instances/probe').set('first');

    expect((await getDatabase(app, 'https://second.firebaseio.com').ref('instances/probe').get()).val()).toBe('first');
    expect((await getDatabase(app).ref('instances/probe').get()).val()).toBe('first');
  });

  test('getDatabaseWithUrl ignores the URL and shares the default tree', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() });

    await getDatabaseWithUrl('https://first.firebaseio.com', app).ref('instances/probe').set('first');

    expect((await getDatabaseWithUrl('https://second.firebaseio.com', app).ref('instances/probe').get()).val()).toBe('first');
    expect((await getDatabase(app).ref('instances/probe').get()).val()).toBe('first');
  });
});
