import { afterEach, describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getDatabase, getDatabaseWithUrl } from '../../src/database/index.js';
import { sharedWorkerArm } from './arms.js';

const DEFAULT_URL = 'https://proj-1-default-rtdb.firebaseio.com';
const LEGACY_URL = 'https://proj-1.firebaseio.com';
const FOREIGN_URL = 'https://other-project.firebaseio.com/items/i1';
const SHARD_URL = 'https://proj-1-shard.firebaseio.com/items/i2';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each([
  {
    name: 'in-process',
    makeSandbox: () => initializeSandbox({ projectId: 'proj-1' }),
  },
  {
    name: 'shared-worker remote',
    makeSandbox: () => sharedWorkerArm().app.sandbox,
  },
])('pyric-admin/database app ownership, URL serialization, and refFromURL host checks ($name)', ({ makeSandbox }) => {
  test('Database.app returns the owning PyricAdminApp, including across distinct apps sharing one sandbox', async () => {
    const sandbox = makeSandbox();
    const appA = initializeApp({ sandbox, projectId: 'proj-1', databaseURL: DEFAULT_URL }, 'app-a');
    const appB = initializeApp({ sandbox, projectId: 'proj-1', databaseURL: LEGACY_URL }, 'app-b');

    const dbA = getDatabase(appA);
    const dbB = getDatabase(appB);

    expect(dbA.app).toBe(appA);
    expect(dbB.app).toBe(appB);

    await dbA.ref('items/shared').set({ count: 7 });
    expect((await dbB.ref('items/shared').get()).val()).toEqual({ count: 7 });
  });

  test('Reference.toString() and Reference.toJSON() return HTTPS URLs that round-trip via refFromURL', async () => {
    const sandbox = makeSandbox();
    const app = initializeApp({ sandbox, projectId: 'proj-1', databaseURL: DEFAULT_URL }, 'url-app');
    const db = getDatabase(app);

    const rootRef = db.ref('/');
    expect(rootRef.toString()).toBe(`${DEFAULT_URL}/`);
    expect(rootRef.toJSON()).toBe(`${DEFAULT_URL}/`);

    const itemRef = db.ref('items/i1');
    expect(itemRef.toString()).toBe(`${DEFAULT_URL}/items/i1`);
    expect(itemRef.toJSON()).toBe(`${DEFAULT_URL}/items/i1`);
    expect(JSON.stringify({ ref: itemRef })).toBe(
      JSON.stringify({ ref: `${DEFAULT_URL}/items/i1` }),
    );

    const encodedRef = db.ref('items/a b+c');
    expect(encodedRef.toString()).toBe(`${DEFAULT_URL}/items/a%20b%2Bc`);

    await itemRef.set({ title: 'first' });
    const roundTripped = db.refFromURL(itemRef.toString());
    expect(roundTripped.key).toBe('i1');
    expect((await roundTripped.get()).val()).toEqual({ title: 'first' });

    const encodedRoundTripped = db.refFromURL(encodedRef.toString());
    expect(encodedRoundTripped.key).toBe('a b+c');
  });

  test('Reference.toString() falls back to projectId host or synthetic sandbox host when databaseURL is omitted', () => {
    const sandbox = makeSandbox();
    const projectOnlyApp = initializeApp({ sandbox, projectId: 'proj-1' }, 'project-only');
    const projectDb = getDatabase(projectOnlyApp);
    expect(projectDb.ref('items/i1').toString()).toBe(`${DEFAULT_URL}/items/i1`);
    expect(projectDb.refFromURL(projectDb.ref('items/i1').toString()).key).toBe('i1');

    const bareApp = initializeApp({ sandbox }, 'bare-app');
    const bareDb = getDatabase(bareApp);
    const bareUrl = bareDb.ref('items/i1').toString();
    expect(bareUrl).toMatch(/^https:\/\/[a-z0-9-]+\.firebaseio\.com\/items\/i1$/);
    expect(bareDb.refFromURL(bareUrl).key).toBe('i1');
  });

  test('refFromURL enforces host matching on default RTDB instances when a URL was configured', () => {
    const sandbox = makeSandbox();
    const app = initializeApp({ sandbox, projectId: 'proj-1', databaseURL: DEFAULT_URL }, 'host-check');

    const defaultDb = getDatabase(app);
    const explicitDefaultDb = getDatabaseWithUrl(DEFAULT_URL, app);
    expect(explicitDefaultDb).toBe(defaultDb);

    expect(() => defaultDb.refFromURL(FOREIGN_URL)).toThrow(
      'FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found other-project.firebaseio.com but expected proj-1-default-rtdb.firebaseio.com) ',
    );
    expect(() => explicitDefaultDb.refFromURL(SHARD_URL)).toThrow(
      'FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found proj-1-shard.firebaseio.com but expected proj-1-default-rtdb.firebaseio.com) ',
    );
    expect(defaultDb.refFromURL(`${DEFAULT_URL}/items/i1`).key).toBe('i1');
  });

  test('getDatabaseWithUrl(defaultUrl, app) activates host validation even when app had no databaseURL', () => {
    const sandbox = makeSandbox();
    const app = initializeApp({ sandbox, projectId: 'proj-1' }, 'no-db-url');
    const db = getDatabase(app);
    const explicitDefaultDb = getDatabaseWithUrl(DEFAULT_URL, app);
    expect(explicitDefaultDb).toBe(db);

    expect(() => explicitDefaultDb.refFromURL(FOREIGN_URL)).toThrow(
      'FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found other-project.firebaseio.com but expected proj-1-default-rtdb.firebaseio.com) ',
    );
  });

  test('refFromURL skips host validation when the database uses a custom non-firebaseio host', () => {
    const sandbox = makeSandbox();
    const app = initializeApp(
      { sandbox, projectId: 'proj-1', databaseURL: 'http://localhost:9000?ns=proj-1' },
      'custom-host',
    );
    const db = getDatabase(app);
    expect(db.ref('items/i1').toString()).toBe('http://localhost:9000/items/i1');
    expect(db.refFromURL(FOREIGN_URL).key).toBe('i1');
  });
});
