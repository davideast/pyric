import { expect, test } from '@playwright/test';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { startHost } from './host-process.js';
import { startHostedFixture } from './fixture.js';

for (const sharedWorkerAvailable of [true, false]) {
  test(`Studio observes the Node-hosted app with SharedWorker available=${sharedWorkerAvailable}`, async ({ browser }) => {
    const fixture = await startHostedFixture();
    const context = await browser.newContext();
    try {
      const disablesSharedWorker = !sharedWorkerAvailable;
      if (disablesSharedWorker) await context.addInitScript(() => { Reflect.deleteProperty(globalThis, 'SharedWorker'); });
      const app = await context.newPage();
      await app.goto(fixture.info.url);
      const studio = await context.newPage();
      await studio.goto(`${fixture.info.url}/__pyric/ui/firestore`);
      await expect(studio.getByText('No collections yet. App or agent writes show up here.')).toBeVisible();
      await app.locator('#write').click();
      await expect(app.locator('#write-result')).toHaveText('Written');
      await expect(studio.getByRole('button', { name: 'shared', exact: true })).toBeVisible();
      await studio.getByRole('button', { name: 'shared', exact: true }).click();
      await expect(studio.getByRole('button', { name: 'greeting', exact: true })).toBeVisible();
      const uid = await app.evaluate(async () => {
        const { getAuth } = await import('firebase/auth');
        return getAuth().currentUser?.uid;
      });
      await studio.getByRole('link', { name: 'Auth', exact: true }).click();
      await expect(studio.locator('body')).toContainText(uid ?? 'missing-user');
      const exited = once(fixture.child, 'exit');
      fixture.child.kill('SIGTERM');
      await exited;
      await expect(studio.getByText('Hosted connection lost; reconnecting.', { exact: true })).toBeVisible();
      await expect(studio.locator('[aria-label="Studio status"]')).not.toContainText('pages connected');
      await expect(studio.locator('[aria-label="Studio status"]')).not.toContainText('MCP bridge');
      const replacement = startHost(fixture.dir, fixture.info.port);
      try {
        expect(await replacement.startup).toEqual({ kind: 'ready' });
        await expect(studio.getByText('Hosted connection lost; reconnecting.', { exact: true })).toHaveCount(0);
        await app.locator('#write').click();
        await expect(app.locator('#write-result')).toHaveText('Written');
        await studio.getByRole('link', { name: 'Firestore', exact: true }).click();
        await expect(studio.getByRole('button', { name: 'shared', exact: true })).toBeVisible();
      } finally {
        await replacement.stop();
      }
    } finally {
      await context.close();
      await fixture.stop();
    }
  });
}

test('Studio persistence diagnostics report committed Storage bytes without disclosing their contents', async ({ browser }) => {
  const fixture = await startHostedFixture({
    'storage.rules': 'rules_version = \"2\"; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read: if request.auth != null; } } }',
  });
  const app = await browser.newPage();
  const studio = await browser.newPage();
  const stateDirectory = join(fixture.dir, '.pyric/state');
  const privateBytes = 'private-storage-phase-six-42';
  try {
    await app.goto(fixture.info.url);
    await expect(app.locator('#document')).toHaveText('Empty');
    await studio.goto(`${fixture.info.url}/__pyric/ui/storage`);
    await expect(studio.getByRole('button', { name: 'Upload files', exact: true })).toBeVisible();
    chmodSync(stateDirectory, 0o500);
    await studio.locator('input[type="file"]').setInputFiles({ name: 'phase-six.txt', mimeType: 'text/plain', buffer: Buffer.from(privateBytes) });
    await expect(studio.locator('[aria-label="Studio status"]')).toContainText('committed in memory');
    const diagnostics = await studio.locator('[aria-label="Studio status"]').innerText();
    expect(diagnostics).not.toContain(privateBytes);
    expect(fixture.stderr()).not.toContain(privateBytes);
    const stored = await app.evaluate(async () => {
      const { getStorage, ref, getBytes } = await import('firebase/storage');
      return new TextDecoder().decode(await getBytes(ref(getStorage(), 'phase-six.txt')));
    });
    expect(stored).toBe(privateBytes);
    chmodSync(stateDirectory, 0o700);
  } finally {
    chmodSync(stateDirectory, 0o700);
    await app.close();
    await studio.close();
    await fixture.stop();
  }
});
