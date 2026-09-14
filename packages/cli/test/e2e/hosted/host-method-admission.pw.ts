import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import { openMethodWire } from './host-method-wire.js';
import { startHostWithPausedStorageRead, startStoragePersistenceFixture } from './storage-persistence-fixture.js';

test('a saturated direct-command connection refuses excess work without losing accepted calls', async ({ page }) => {
  const fixture = await startStoragePersistenceFixture();
  const list = () => promisify(execFile)(process.execPath,
    [CLI_PATH, 'storage', 'listAll', '--prefix', 'files', '--json'], { cwd: fixture.dir, timeout: 10_000 });
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
        await expect.poll(host.stderr).toContain('Storage binary read paused');
        for (const _ of Array.from({ length: 255 })) {
          wire.command('storage.getBytes', { path: 'files/shared.txt' });
        }
        wire.command('storage.deleteObject', { path: 'files/shared.txt' });
        wire.checkpoint();
        await expect.poll(host.stderr).toContain('HTTP pipeline received');
        const healthy = await list();
        expect(healthy.stderr).toContain('hosted sandbox');
        expect(healthy.stdout).toContain('files/shared.txt');
        host.child.kill('SIGUSR2');
        await expect.poll(wire.received).toContain('This client already has 256 pending operations.');
        const successfulReads = () => wire.received().match(/"contentBase64":"RXhpc3Rpbmcgb2JqZWN0"/g)?.length;
        expect(successfulReads()).toBe(256);
        const afterRefusal = await list();
        expect(JSON.parse(afterRefusal.stdout)).toMatchObject({ ok: true, data: { items: ['files/shared.txt'] } });
        // The same physical connection can refill after both success and failure.
        for (const _ of Array.from({ length: 256 })) {
          wire.command('storage.getBytes', { path: 'files/missing.txt' });
        }
        await expect.poll(() => wire.received().match(/"ok":false/g)?.length).toBe(257);
        expect(wire.received().match(/already has 256 pending operations/g)).toHaveLength(1);
        for (const _ of Array.from({ length: 256 })) {
          wire.command('storage.getBytes', { path: 'files/shared.txt' });
        }
        await expect.poll(successfulReads).toBe(512);
        wire.finish();
        const replies = await wire.result();
        expect(replies.match(/already has 256 pending operations/g)).toHaveLength(1);
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
