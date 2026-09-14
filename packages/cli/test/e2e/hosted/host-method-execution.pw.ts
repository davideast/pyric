import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import { startHostWithPausedStorageRead, startStoragePersistenceFixture } from './storage-persistence-fixture.js';
import { openMethodWire } from './host-method-wire.js';

test('a stalled service CLI read does not block another CLI caller', async ({ page }) => {
  const fixture = await startStoragePersistenceFixture();
  const command = (args: string[]) => promisify(execFile)(process.execPath, [CLI_PATH, ...args, '--json'], {
    cwd: fixture.dir, timeout: 10_000,
  });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.getByLabel('Value', { exact: true }).fill('Existing object');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#saved')).toHaveText('Saved');
    await page.close();
    const host = await startHostWithPausedStorageRead(fixture);
    try {
      expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
      const busy = command(['storage', 'getBytes', '--path', 'files/shared.txt']);
      await expect.poll(host.stderr).toContain('Storage binary read paused');
      let listing: string | undefined;
      const healthy = command(['storage', 'listAll', '--prefix', 'files']).then(result => {
        expect(result.stderr).toContain('hosted sandbox');
        listing = result.stdout;
      });
      try {
        await expect.poll(() => listing, { timeout: 3_000 }).toContain('files/shared.txt');
      } finally {
        host.child.kill('SIGUSR2');
        const result = await busy;
        expect(result.stderr).toContain('hosted sandbox');
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { contentBase64: 'RXhpc3Rpbmcgb2JqZWN0' } });
        await healthy;
      }
    } finally {
      host.child.kill('SIGUSR2');
      await host.stop();
    }
  } finally {
    await fixture.stop();
  }
});

test('commands on one HTTP connection retain order while another caller reads', async ({ page }) => {
  const fixture = await startStoragePersistenceFixture();
  const command = (args: string[]) => promisify(execFile)(process.execPath, [CLI_PATH, ...args, '--json'], {
    cwd: fixture.dir, timeout: 10_000,
  });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.getByLabel('Value', { exact: true }).fill('Existing object');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#saved')).toHaveText('Saved');
    await page.close();
    const host = await startHostWithPausedStorageRead(fixture);
    try {
      expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
      const wire = await openMethodWire(fixture.info.url, fixture.dir);
      try {
        wire.command('storage.getBytes', { path: 'files/shared.txt' });
        await expect.poll(() => `${host.stderr()}\n${wire.received()}`).toContain('Storage binary read paused');
        wire.command('storage.deleteObject', { path: 'files/shared.txt' });
        wire.finish();
        await expect.poll(host.stderr).toContain('HTTP pipeline received');
        const listing = await command(['storage', 'listAll', '--prefix', 'files']);
        expect(listing.stdout).toContain('files/shared.txt');
        host.child.kill('SIGUSR2');
        const replies = await wire.result();
        expect(replies).toContain('RXhpc3Rpbmcgb2JqZWN0');
        expect(replies).toContain('Deleted files/shared.txt');
        const afterDelete = await command(['storage', 'listAll', '--prefix', 'files']);
        expect(JSON.parse(afterDelete.stdout)).toMatchObject({ ok: true, data: { items: [] } });
        const invalid = command(['storage', 'getBytes', '--path', 'files/missing.txt']);
        await expect(invalid).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('hosted sandbox') });
        await expect(command(['storage', 'listAll', '--prefix', 'files'])).resolves.toMatchObject({
          stdout: expect.stringContaining('"ok": true'),
        });
      } finally {
        host.child.kill('SIGUSR2');
        await wire.close();
      }
    } finally {
      host.child.kill('SIGUSR2');
      await host.stop();
    }
  } finally {
    await fixture.stop();
  }
});
