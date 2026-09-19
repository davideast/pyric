import { once } from 'node:events';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startHost } from './host-process.js';
import { waitForPeer } from '../soak/harness.js';
import { startHostWithPausedStorageRead, startStoragePersistenceFixture } from './storage-persistence-fixture.js';

test('an acknowledged import cannot restore Storage objects from a save already in flight', async ({ browser }) => {
  test.setTimeout(30_000);
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
        await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('hosted');
        await expect(page.locator('#ready')).toHaveText('Ready');
      }
      const remote = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        const exported = await remote.channel.op({ method: 'exportState' });
        const hasBundle = typeof exported === 'object' && exported !== null && 'bundle' in exported;
        const isMissingBundle = !hasBundle;
        if (isMissingBundle) throw new Error('Expected an exported state bundle');
        const bundle = exported.bundle;
        const isInvalidBundle = typeof bundle !== 'string';
        if (isInvalidBundle) throw new Error('Expected a string state bundle');
        await writer.getByLabel('Value', { exact: true }).fill('Discarded by import');
        await writer.getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(host.stderr).toContain('Storage binary read paused');
        const imported = remote.channel.op({ method: 'importState', bundle });
        await expect.poll(async () => {
          await observer.getByRole('button', { name: 'List files', exact: true }).click();
          return observer.locator('#files').innerText();
        }).toBe('[]');
        host.child.kill('SIGUSR2');
        await expect(imported).resolves.toEqual({ ok: true });
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

test('default SharedWorker import replaces Storage and preserves subsequent SDK uploads', async ({ page }) => {
  const fixture = await startStoragePersistenceFixture(['--no-capture']);
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await waitForPeer(fixture.info.url);
    const remote = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      const exported = await remote.channel.op({ method: 'exportState' });
      const hasBundle = typeof exported === 'object' && exported !== null && 'bundle' in exported;
      const isMissingBundle = !hasBundle;
      if (isMissingBundle) throw new Error('Expected an exported state bundle');
      const bundle = exported.bundle;
      const isInvalidBundle = typeof bundle !== 'string';
      if (isInvalidBundle) throw new Error('Expected a string state bundle');
      await page.getByLabel('Value', { exact: true }).fill('Discarded by import');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.locator('#saved')).toHaveText('Saved');
      await expect(remote.channel.op({ method: 'importState', bundle })).resolves.toEqual({ ok: true });
    } finally {
      remote.close();
    }
    await page.reload();
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.getByRole('button', { name: 'List files', exact: true }).click();
    await expect(page.locator('#files')).toHaveText('[]');
    await page.getByLabel('Value', { exact: true }).fill('After import');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#saved')).toHaveText('Saved');
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.locator('#value-read')).toHaveText('After import');
  } finally {
    await fixture.stop();
  }
});
