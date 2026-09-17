import { setPersistenceWritable } from './persistence-fault.js';
import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { join } from 'node:path';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

const secret = 'credential-phase-six-42';
const privateData = 'private-document-phase-six-42';

test('hosted diagnostics distinguish connection loss and persistence failure, omit private data, and recover', async ({ page }) => {
  const fixture = await startHostedFixture();
  const stateDirectory = join(fixture.dir, '.pyric', 'state');
  const consoleMessages: string[] = [];
  page.on('console', message => consoleMessages.push(message.text()));
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.evaluate(async ({ secret, privateData }) => {
      const { getAuth, createUserWithEmailAndPassword } = await import('firebase/auth');
      const { doc, getFirestore, setDoc } = await import('firebase/firestore');
      await createUserWithEmailAndPassword(getAuth(), 'diagnostics@example.test', secret);
      await setDoc(doc(getFirestore(), 'shared/greeting'), { message: privateData });
    }, { secret, privateData });
    await page.getByRole('button', { name: 'Open pyric' }).click();
    await page.getByRole('tab', { name: 'Sandbox', exact: true }).click();
    await expect(page.locator('[data-worker-row]')).toContainText('Hosted');
    await expect(page.locator('[data-worker-row]')).toContainText('Connected');
    const stopped = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await stopped;
    await expect(page.locator('[data-worker-row]')).toContainText('Reconnecting');
    await page.locator('#write').click();
    await expect(page.locator('#write-result')).toContainText('connection is closed');
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup).toEqual({ kind: 'ready' });
      await expect(page.locator('[data-worker-row]')).toContainText('Connected');
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      setPersistenceWritable(stateDirectory, false);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toContainText('committed in memory');
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().errors)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'committed-but-not-durable', message: expect.stringContaining('persisted') }),
      ]));
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toContainText('persistence is unhealthy');
      const diagnostics = JSON.stringify({
        runtime: await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot()),
        consoleMessages,
        stderr: fixture.stderr() + replacement.stderr(),
      });
      expect(diagnostics).not.toContain(secret);
      expect(diagnostics).not.toContain(privateData);
      setPersistenceWritable(stateDirectory, true);
    } finally {
      setPersistenceWritable(stateDirectory, true);
      await replacement.stop();
    }
    const repaired = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await repaired.startup).toEqual({ kind: 'ready' });
      await expect(page.locator('[data-worker-row]')).toContainText('Connected');
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      // Error history remains available; it is not the current connection status.
      await page.reload();
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().errors)).toEqual([]);
    } finally {
      await page.close();
      await repaired.stop();
    }
  } finally {
    await fixture.stop();
  }
});
