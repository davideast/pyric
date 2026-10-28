/**
 * `pyric-admin`: an app whose `databaseURL` is the legacy
 * `https://<projectId>.firebaseio.com` targets the project's default
 * instance, as `getDatabase(app)` without a URL does (#1062).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getDatabase, getDatabaseWithUrl } from '../../src/database/index.js';

const PROJECT = 'legacy-admin';
const LEGACY_URL = `https://${PROJECT}.firebaseio.com`;

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('a legacy https://<projectId>.firebaseio.com databaseURL', () => {
  test('getDatabase(app) writes the default instance', async () => {
    const sandbox = initializeSandbox();
    const legacy = initializeApp({ sandbox, projectId: PROJECT, databaseURL: LEGACY_URL }, 'legacy');
    const noUrl = initializeApp({ sandbox, projectId: PROJECT }, 'no-url');

    await getDatabase(legacy).ref('probe').set('from legacy');

    expect((await getDatabase(noUrl).ref('probe').get()).val()).toBe('from legacy');
  });

  test('getDatabaseWithUrl(<legacy URL>) is the database getDatabase(app) returns', () => {
    const app = initializeApp({ sandbox: initializeSandbox(), projectId: PROJECT });

    expect(getDatabaseWithUrl(LEGACY_URL, app)).toBe(getDatabase(app));
  });
});
