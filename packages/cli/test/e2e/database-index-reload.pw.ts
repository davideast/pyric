import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';

let directory: string;
let server: ServeRuntime;
test.beforeAll(async () => {
  test.setTimeout(90_000);
  directory = await mkdtemp(join(tmpdir(), 'pyric-index-reload-'));
  await writeFile(join(directory, 'firebase.json'), JSON.stringify({ hosting: { public: '.' }, database: { rules: 'database.rules.json' } }));
  await writeFile(join(directory, 'database.rules.json'), `{
  // Keep this security policy and comment through both edits.
  "rules": {
    ".read": true,
    ".write": true,
    "projects-inpage": { "$id": { ".validate": "newData.hasChildren(['score', 'rank'])" } },
    "projects-worker": { "$id": { ".validate": "newData.hasChildren(['score', 'rank'])" } }
  }
}`);
  await writeFile(join(directory, 'index.html'), '<!doctype html><meta name="pyric-runtime-chip" content="expanded"><div id="ready">Loading</div><script type="module" src="/app.js"></script>');
  await writeFile(join(directory, 'app.js'), `
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, get, query, orderByChild } from 'firebase/database';
const db = getDatabase(initializeApp({ projectId: 'index-reload', databaseURL: 'https://index-reload.firebaseio.com' }));
const path = 'projects-' + new URL(location.href).searchParams.get('runtime');
const target = ref(db, path);
await set(target, { a: { score: 1, rank: 2 }, b: { score: 2, rank: 1 } });
window.readIndexed = async field => {
  try { return { data: (await get(query(target, orderByChild(field)))).val() }; }
  catch (error) { return { error: error.message }; }
};
document.querySelector('#ready').textContent = 'Ready';
`);
  server = await startServe({ cwd: directory, port: 0, host: '127.0.0.1', noCache: true,
    cacheRoot: join(directory, '.cache'), watch: true, bridge: false, ui: false, capture: false });
});
test.afterAll(async () => {
  await server?.handle.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: two atomic index saves update the running rules engine without reloading the page`, async ({ page }) => {
    test.setTimeout(60_000);
    page.on('pageerror', error => console.error('Index reload page error:', error.message));
    await page.setViewportSize({ width: 1500, height: 1050 });
    if (runtime === 'inpage') await page.addInitScript(() => {
      (globalThis as typeof globalThis & { __PYRIC_FORCE_INPAGE__: boolean }).__PYRIC_FORCE_INPAGE__ = true;
    });
    await page.goto(`${server.handle.url}/?runtime=${runtime}`);
    await expect(page.locator('#ready')).toHaveText('Ready');
    const read = (field: string) => page.evaluate(field => {
      const app = window as typeof window & { readIndexed(field: string): Promise<{ error?: string; data?: unknown }> };
      return app.readIndexed(field);
    }, field);
    for (const field of ['score', 'rank']) {
      expect((await read(field)).error).toContain('Index not defined');
      await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
      const back = page.locator('[data-clear-traffic-source]');
      if (await back.count()) await back.click();
      await page.locator('[data-inspect-request]').filter({ hasText: `projects-${runtime}` }).first().click();
      await expect(page.locator('[data-index-details]')).toContainText(field);
      await page.getByRole('button', { name: 'Add index', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Add index', exact: true })).toHaveAttribute('data-save-state', 'saved');
      // No fixture-side setRules and no reload: the production file watcher,
      // session event stream and selected runtime must deliver this change.
      await expect.poll(async () => (await read(field)).error, { timeout: 10_000 }).toBeUndefined();
    }
    const rules = await readFile(join(directory, 'database.rules.json'), 'utf8');
    expect(rules).toContain('// Keep this security policy and comment through both edits.');
    expect(rules).toContain("newData.hasChildren(['score', 'rank'])");
    expect(rules).toContain('"score"');
    expect(rules).toContain('"rank"');
  });
}
