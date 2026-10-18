/**
 * In-page sandbox: an app whose `databaseURL` is the legacy
 * `https://<projectId>.firebaseio.com` uses the project's default instance,
 * with the default instance's rules and data (#1062).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps } from '../../src/app/index.js';
import { createAppForSandbox } from '../../src/app/internal.js';
import { getAdminDatabase, getDatabase, get, ref, set } from '../../src/database/index.js';
import { setRules } from '../../src/database/sandbox-controls.js';
import { heldDatabaseInstances } from '../../src/database/internal.js';

const PROJECT = 'legacy-page';
const LEGACY_URL = `https://${PROJECT}.firebaseio.com`;
const DEFAULT_RULES = {
  rules: {
    open: { '.read': true, '.write': true },
    closed: { '.read': false, '.write': false },
  },
};

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

let appCount = 0;
const appName = (): string => `legacy-page-${++appCount}`;

/** A sandbox with the default instance's rules deployed, as firebase.json's `database.rules` deploys them. */
function sandboxWithDefaultRules() {
  const sandbox = initializeSandbox();
  setRules(getDatabase(sandbox), DEFAULT_RULES);
  return sandbox;
}

describe('a legacy https://<projectId>.firebaseio.com databaseURL', () => {
  test('gets the default instance rules', async () => {
    const sandbox = sandboxWithDefaultRules();
    const app = createAppForSandbox(sandbox, { projectId: PROJECT, databaseURL: LEGACY_URL }, appName());
    const db = getDatabase(app);
    await set(ref(db, 'open/a'), 1);
    await expect(set(ref(db, 'closed/a'), 1)).rejects.toThrow('PERMISSION_DENIED');
  });

  test('reads and writes the data getDatabase(app) without a URL does', async () => {
    const sandbox = sandboxWithDefaultRules();
    const legacy = createAppForSandbox(sandbox, { projectId: PROJECT, databaseURL: LEGACY_URL }, appName());
    const noUrl = createAppForSandbox(sandbox, { projectId: PROJECT }, appName());
    await set(ref(getDatabase(legacy), 'open/a'), 'from legacy');
    expect((await get(ref(getDatabase(noUrl), 'open/a'))).val()).toBe('from legacy');
    expect((await get(ref(getAdminDatabase(sandbox), 'open/a'))).val()).toBe('from legacy');
    expect(heldDatabaseInstances(sandbox)).not.toContain(PROJECT);
  });

  test('the legacy URL passed to getDatabase(app, url) selects the default instance', async () => {
    const sandbox = sandboxWithDefaultRules();
    const app = createAppForSandbox(sandbox, { projectId: PROJECT }, appName());
    await set(ref(getDatabase(app, LEGACY_URL), 'open/a'), 2);
    expect((await get(ref(getAdminDatabase(sandbox), 'open/a'))).val()).toBe(2);
  });

  test('an emulator ns=<projectId> URL selects the default instance', async () => {
    const sandbox = sandboxWithDefaultRules();
    const app = createAppForSandbox(sandbox, { projectId: PROJECT, databaseURL: `http://127.0.0.1:9000?ns=${PROJECT}` }, appName());
    await set(ref(getDatabase(app), 'open/a'), 3);
    expect((await get(ref(getAdminDatabase(sandbox), 'open/a'))).val()).toBe(3);
  });

  test('getAdminDatabase(app) reads the default instance', async () => {
    const sandbox = sandboxWithDefaultRules();
    await set(ref(getAdminDatabase(sandbox), 'closed/a'), 'admin wrote');
    const app = createAppForSandbox(sandbox, { projectId: PROJECT, databaseURL: LEGACY_URL }, appName());
    expect((await get(ref(getAdminDatabase(app), 'closed/a'))).val()).toBe('admin wrote');
  });

  test('another project\'s legacy URL stays its own instance', async () => {
    const sandbox = sandboxWithDefaultRules();
    const app = createAppForSandbox(sandbox, { projectId: PROJECT, databaseURL: 'https://other-project.firebaseio.com' }, appName());
    await expect(set(ref(getDatabase(app), 'open/a'), 1)).rejects.toThrow('PERMISSION_DENIED');
  });
});
