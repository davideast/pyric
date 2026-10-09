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

const SHARD_URL = 'https://demo-app-shard-1.firebaseio.com';
const DEFAULT_URL = 'https://demo-app-default-rtdb.firebaseio.com';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

// Production binds each database URL to its own instance, with its own data.
describe('database URL selection', () => {
  test('getDatabaseWithUrl writes to the instance its URL names, not the default instance', async () => {
    const app = initializeApp({ sandbox: initializeSandbox(), projectId: 'demo-app' });

    await getDatabaseWithUrl(SHARD_URL, app).ref('rooms/r1').set({ members: { u1: true } });

    expect((await getDatabaseWithUrl(SHARD_URL, app).ref('rooms/r1').get()).val()).toEqual({ members: { u1: true } });
    expect((await getDatabaseWithUrl(DEFAULT_URL, app).ref('rooms/r1').get()).exists()).toBe(false);
    expect((await getDatabase(app).ref('rooms/r1').get()).exists()).toBe(false);
  });

  test('getDatabase(app, url) selects the instance its URL names', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() });

    await getDatabase(app, 'https://first.firebaseio.com').ref('instances/probe').set('first');
    await getDatabase(app, 'https://second.firebaseio.com').ref('instances/probe').set('second');

    expect((await getDatabase(app, 'https://first.firebaseio.com').ref('instances/probe').get()).val()).toBe('first');
    expect((await getDatabaseWithUrl('https://second.firebaseio.com', app).ref('instances/probe').get()).val()).toBe('second');
    expect((await getDatabase(app).ref('instances/probe').get()).exists()).toBe(false);
  });

  test('the project default URL and getDatabase(app) name one instance', async () => {
    const app = initializeApp({ sandbox: initializeSandbox(), projectId: 'demo-app' });

    await getDatabaseWithUrl(DEFAULT_URL, app).ref('functions/created').set({ value: 42 });

    expect((await getDatabase(app).ref('functions/created').get()).val()).toEqual({ value: 42 });
    expect(getDatabaseWithUrl(DEFAULT_URL, app)).toBe(getDatabase(app));
  });

  test('getDatabase(app) uses the instance the app databaseURL option names', async () => {
    const app = initializeApp({ sandbox: initializeSandbox(), databaseURL: SHARD_URL });

    await getDatabase(app).ref('probe').set('shard');

    expect((await getDatabaseWithUrl(SHARD_URL, app).ref('probe').get()).val()).toBe('shard');
    expect(getDatabase(app)).toBe(getDatabaseWithUrl(SHARD_URL, app));
  });

  test('one Database per sandbox and instance', () => {
    const app = initializeApp({ sandbox: initializeSandbox() });

    expect(getDatabaseWithUrl(SHARD_URL, app)).toBe(getDatabaseWithUrl(SHARD_URL, app));
    expect(getDatabase(app)).toBe(getDatabase(app));
    expect(getDatabaseWithUrl(SHARD_URL, app)).not.toBe(getDatabase(app));
  });

  test('sandbox.reset() clears every instance', async () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox });
    await getDatabase(app).ref('probe').set('default');
    await getDatabaseWithUrl(SHARD_URL, app).ref('probe').set('shard');

    await sandbox.reset();

    expect((await getDatabase(app).ref('probe').get()).exists()).toBe(false);
    expect((await getDatabaseWithUrl(SHARD_URL, app).ref('probe').get()).exists()).toBe(false);
  });

  test('a URL that does not parse throws the SDK error', () => {
    const app = initializeApp({ sandbox: initializeSandbox() });

    expect(() => getDatabaseWithUrl('https://firebaseio.com', app)).toThrow(
      'FIREBASE FATAL ERROR: Cannot parse Firebase url. Please use https://<YOUR FIREBASE>.firebaseio.com ',
    );
    expect(() => getDatabaseWithUrl(`${SHARD_URL}/rooms`, app)).toThrow(
      'FIREBASE FATAL ERROR: Database URL must point to the root of a Firebase Database (not including a child path). ',
    );
    expect(() => getDatabaseWithUrl('', app)).toThrow('Database URL must be a valid, non-empty URL string.');
  });

  test('refFromURL rejects a URL for another instance and reads its own', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    const shard = getDatabaseWithUrl(SHARD_URL, app);
    await shard.ref('rooms/r1').set('here');

    expect((await shard.refFromURL(`${SHARD_URL}/rooms/r1`).get()).val()).toBe('here');
    expect(() => shard.refFromURL(`${DEFAULT_URL}/rooms/r1`)).toThrow(
      'FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found demo-app-default-rtdb.firebaseio.com but expected demo-app-shard-1.firebaseio.com) ',
    );
  });
});
