import assert from 'node:assert/strict';
import { scenario, type ExpectedCrash } from '../driver.ts';

export const expectedCrashes: ExpectedCrash[] = [
  {
    message: /^Error: WebSocket closed without opened\.$/,
    source: /^page http:\/\/127\.0\.0\.1:\d+\/ \(at http:\/\/127\.0\.0\.1:\d+\/@vite\/client:\d+\)$/,
    reason: "vite.config.js points Vite's HMR client at port 1 so it never reloads the page, and the client rejects when that socket fails",
  },
];

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  await app.step('deploy restrictive firestore rules', async () => {
    const rules = `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }`;
    await app.serverScript('./node_modules/.bin/pyric', ['rules', 'set', '--service', 'firestore', '--rules', rules], { env: { PYRIC_SANDBOX: `remote:${host.url}` } });
  });

  const page = await app.step('open the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'counters' in window, undefined, { timeout: 30_000 });
    const result = await page.evaluate(() => counters.write());
    assert.equal(result, 'permission-denied');
    return page;
  });

  await app.step('deploy permissive rules with lint errors', async () => {
    const rules = `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }`;
    await app.serverScript('./node_modules/.bin/pyric', ['rules', 'set', '--service', 'firestore', '--rules', rules], { env: { PYRIC_SANDBOX: `remote:${host.url}` } });
  });

  await app.step('write should now succeed', async () => {
    const result = await page.evaluate(() => counters.write());
    assert.equal(result, true);
  });

  await app.step('reset sandbox', async () => {
    await app.serverScript('./node_modules/.bin/pyric', ['sandbox', 'reset', '--confirm'], { env: { PYRIC_SANDBOX: `remote:${host.url}` } });
  });

  await app.step('write should still succeed because permissive rules are preserved', async () => {
    const result = await page.evaluate(() => counters.write());
    assert.equal(result, true);
  });
});
