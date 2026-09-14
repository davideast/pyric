import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { CLI_PATH, McpHttpClient } from '../soak/harness.js';
import { writeHeldStorageReadPreload } from './held-storage-read.js';
import { openMethodWire } from './host-method-wire.js';
import { startHost } from './host-process.js';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

test('closed direct-command connections retain bounded execution ownership until drain', async ({ page }) => {
  const fixture = await startStoragePersistenceFixture();
  const command = (args: string[]) => promisify(execFile)(process.execPath, [CLI_PATH, ...args, '--json'], {
    cwd: fixture.dir, timeout: 10_000,
  });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.evaluate(async () => {
      const app = await import('firebase/app');
      const storage = await import('firebase/storage');
      await storage.uploadBytes(storage.ref(storage.getStorage(app.getApp()), 'files/shared.txt'),
        new TextEncoder().encode('Existing object'), { contentType: 'application/x-pyric-held' });
    });
    const firstExit = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await firstExit;
    const preload = join(fixture.dir, 'hold-command-read.mjs');
    writeHeldStorageReadPreload(preload, false);
    const host = startHost(fixture.dir, fixture.info.port, [process.execPath, '--import', preload, CLI_PATH]);
    let holding = true;
    try {
      expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
      await page.reload();
      await expect(page.locator('#ready')).toHaveText('Ready');
      const mcp = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
      await mcp.initialize();
      for (const round of [0, 1]) {
        const rearmsReads = round === 1;
        if (rearmsReads) {
          host.child.kill('SIGUSR2');
          holding = true;
          await expect.poll(host.stderr).toContain('ARMED\n');
        }
        const acceptedPath = `held/accepted-${round}`;
        for (const index of Array.from({ length: 64 }, (_, index) => index)) {
          const wire = await openMethodWire(fixture.info.url, fixture.dir);
          try {
            wire.command('storage.getBytes', { path: 'files/shared.txt' });
            // Actual platform I/O establishes admission before the caller closes.
            await expect.poll(() => host.stderr().split('HELD\n').length - 1, { intervals: [10, 25, 50] })
              .toBe(round * 64 + index + 1);
            const isLastOwner = index === 63;
            if (isLastOwner) {
              wire.command('firestore.setDoc', { path: acceptedPath, data: { round } });
              wire.checkpoint();
              await expect.poll(() => host.stderr().split('HTTP pipeline received\n').length - 1).toBe(round + 1);
            }
          } finally {
            await wire.close();
          }
        }
        const visibleFiles = await page.evaluate(async () => {
          const app = await import('firebase/app');
          const storage = await import('firebase/storage');
          const listing = await storage.listAll(storage.ref(storage.getStorage(app.getApp()), 'files'));
          return listing.items.map(item => item.fullPath);
        });
        expect(visibleFiles).toEqual(['files/shared.txt']);
        await expect(mcp.toolCall('firestore_get_document', { path: 'limit/unwritten', as: 'admin' }))
          .resolves.toMatchObject({ ok: true, data: { exists: false } });
        await expect(command(['storage', 'deleteObject', '--path', 'files/shared.txt'])).rejects.toMatchObject({
          code: 2,
          stderr: expect.stringContaining('hosted sandbox'),
          stdout: expect.stringContaining('direct-command connection cap (64)'),
        });
        host.child.kill('SIGUSR2');
        holding = false;
        const afterDrain = await command(['storage', 'listAll', '--prefix', 'files']);
        expect(JSON.parse(afterDrain.stdout)).toMatchObject({ ok: true, data: { items: ['files/shared.txt'] } });
        await expect.poll(() => mcp.toolCall('firestore_get_document', { path: acceptedPath, as: 'admin' }))
          .toMatchObject({ ok: true, data: { exists: true, data: { round } } });
        // A completed durable command orders persistence drain before rearming I/O.
        await command(['firestore', 'setDoc', '--path', 'held/barrier', '--data', JSON.stringify({ round })]);
      }
    } finally {
      if (holding) host.child.kill('SIGUSR2');
      await host.stop();
    }
  } finally {
    await fixture.stop();
  }
});
