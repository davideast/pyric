import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { startHostWithPausedStorageRead, startStoragePersistenceFixture } from './storage-persistence-fixture.js';
import { startHost } from './host-process.js';

test('overlapping Storage saves cannot restore an older value after both uploads acknowledge', async ({ browser }) => {
  const fixture = await startStoragePersistenceFixture();
  const context = await browser.newContext();
  try {
    const host = await startHostWithPausedStorageRead(fixture);
    try {
      expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
      const first = await context.newPage();
      const second = await context.newPage();
      const observer = await context.newPage();
      for (const page of [first, second, observer]) {
        await page.goto(fixture.info.url);
        await expect(page.locator('#ready')).toHaveText('Ready');
      }
      await first.getByLabel('Value', { exact: true }).fill('Older value');
      await first.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(host.stderr).toContain('Storage binary read paused');
      await second.getByLabel('Value', { exact: true }).fill('Newer value');
      await second.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(second.locator('#saved')).toHaveText('');

      host.child.kill('SIGUSR2');
      await expect(first.locator('#saved')).toHaveText('Saved');
      await expect(second.locator('#saved')).toHaveText('Saved');
      const exit = once(host.child, 'exit');
      host.child.kill('SIGKILL');
      await exit;
      await context.close();

      const replacement = startHost(fixture.dir, fixture.info.port);
      try {
        expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
        const reader = await browser.newPage();
        try {
          await reader.goto(fixture.info.url);
          await expect(reader.locator('#ready')).toHaveText('Ready');
          await reader.getByRole('button', { name: 'Read', exact: true }).click();
          await expect(reader.locator('#value-read')).toHaveText('Newer value');
        } finally {
          await reader.close();
        }
      } finally {
        await replacement.stop();
      }
    } finally {
      host.child.kill('SIGUSR2');
      await host.stop();
    }
  } finally {
    await context.close().finally(() => fixture.stop());
  }
});
