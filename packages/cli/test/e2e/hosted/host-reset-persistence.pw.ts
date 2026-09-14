import { once } from 'node:events';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { waitForPeer } from '../soak/harness.js';
import { startHost } from './host-process.js';
import { startHostWithPausedStorageRead, startStoragePersistenceFixture } from './storage-persistence-fixture.js';

test('an acknowledged reset cannot restore objects from a save that was already in flight', async ({ browser }) => {
  const fixture = await startStoragePersistenceFixture();
  const context = await browser.newContext();
  try {
    const host = await startHostWithPausedStorageRead(fixture);
    try {
      expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
      const writer = await context.newPage();
      const observer = await context.newPage();
      for (const page of [writer, observer]) {
        await page.goto(fixture.info.url);
        await expect(page.locator('#ready')).toHaveText('Ready');
      }
      await writer.getByLabel('Value', { exact: true }).fill('Discarded by reset');
      await writer.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(host.stderr).toContain('Storage binary read paused');

      const remote = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        const reset = remote.channel.op({ method: 'resetAll' });
        await expect.poll(async () => {
          await observer.getByRole('button', { name: 'List files', exact: true }).click();
          return observer.locator('#files').innerText();
        }).toBe('[]');
        host.child.kill('SIGUSR2');
        await expect(reset).resolves.toEqual({ errors: [] });
        await expect(writer.locator('#saved')).toHaveText('Saved');
      } finally {
        remote.close();
      }

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
          await reader.getByRole('button', { name: 'List files', exact: true }).click();
          await expect(reader.locator('#files')).toHaveText('[]');
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
    await context.close();
    await fixture.stop();
  }
});

test('default SharedWorker reset clears Storage and preserves subsequent SDK uploads', async ({ page }) => {
  const fixture = await startStoragePersistenceFixture(['--no-capture']);
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.getByLabel('Value', { exact: true }).fill('Before reset');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#saved')).toHaveText('Saved');
    await waitForPeer(fixture.info.url);
    const remote = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await expect(remote.channel.op({ method: 'resetAll' })).resolves.toEqual({ errors: [] });
    } finally {
      remote.close();
    }
    await page.getByRole('button', { name: 'List files', exact: true }).click();
    await expect(page.locator('#files')).toHaveText('[]');
    await page.reload();
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.getByRole('button', { name: 'List files', exact: true }).click();
    await expect(page.locator('#files')).toHaveText('[]');
    await page.getByLabel('Value', { exact: true }).fill('After reset');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#saved')).toHaveText('Saved');
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.locator('#value-read')).toHaveText('After reset');
  } finally {
    await fixture.stop();
  }
});

test('an unhealthy host refuses reset before clearing Storage objects', async ({ page }) => {
  const fixture = await startStoragePersistenceFixture();
  const stateDirectory = join(fixture.dir, '.pyric', 'state');
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await page.getByLabel('Value', { exact: true }).fill('Still in memory');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#saved')).toHaveText('committed-but-not-durable');
    const remote = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await expect(remote.channel.op({ method: 'resetAll' })).rejects.toMatchObject({ code: 'persistence-unhealthy' });
    } finally {
      remote.close();
    }
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.locator('#value-read')).toHaveText('Still in memory');
  } finally {
    chmodSync(stateDirectory, 0o700);
    await fixture.stop();
  }
});
