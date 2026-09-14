import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import { writeHeldStorageReadPreload } from './held-storage-read.js';
import { openMethodWire } from './host-method-wire.js';
import { startHost } from './host-process.js';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

/** Count a response marker across TCP fragments without retaining large path echoes. */
function countWireText(marker: string) {
  let tail = '';
  let count = 0;
  const retainedCharacters = marker.length - 1;
  return {
    receive(chunk: string) {
      const text = tail + chunk;
      count += text.split(marker).length - 1;
      tail = text.slice(-retainedCharacters);
    },
    count: () => count,
  };
}

const scenarios = [
  { boundary: 0, failsReads: false },
  { boundary: -1, failsReads: false },
  { boundary: 1, failsReads: false },
  { boundary: 0, failsReads: true },
];

for (const { boundary, failsReads } of scenarios) {
  test(`direct commands enforce 24 MiB ${boundary}, failing reads: ${failsReads}`, async ({ page }) => {
    const fixture = await startStoragePersistenceFixture();
    const list = () => promisify(execFile)(process.execPath,
      [CLI_PATH, 'storage', 'listAll', '--prefix', 'files', '--json'], { cwd: fixture.dir, timeout: 10_000 });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#ready')).toHaveText('Ready');
      await page.evaluate(async () => {
        const app = await import('firebase/app');
        const storage = await import('firebase/storage');
        await storage.uploadBytes(storage.ref(storage.getStorage(app.getApp()), 'files/é.txt'),
          new TextEncoder().encode('Existing object'), { contentType: 'application/x-pyric-held' });
      });
      await page.close();
      const firstExit = once(fixture.child, 'exit');
      fixture.child.kill('SIGTERM');
      await firstExit;
      const preload = join(fixture.dir, 'hold-command-read.mjs');
      writeHeldStorageReadPreload(preload, failsReads);
      const host = startHost(fixture.dir, fixture.info.port, [process.execPath, '--import', preload, CLI_PATH]);
      let holding = true;
      try {
        expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
        const completed = countWireText('"contentBase64":"RXhpc3Rpbmcgb2JqZWN0"');
        const failed = countWireText('Controlled binary read failure');
        const refused = countWireText('24 MiB queued operation byte limit');
        const wire = await openMethodWire(fixture.info.url, fixture.dir, chunk => {
          completed.receive(chunk);
          failed.receive(chunk);
          refused.receive(chunk);
        });
        try {
          const operationBytes = 786_432;
          const path = 'files/é.txt';
          const overhead = wire.byteLength('storage.getBytes', { path });
          function readArgs(bytes: number) {
            const args = { path: '/'.repeat(bytes - overhead) + path };
            expect(wire.byteLength('storage.getBytes', args)).toBe(bytes);
            return args;
          }
          const args = readArgs(operationBytes);
          const firstPhaseReads = failsReads ? failed.count : completed.count;
          const exceedsLimit = boundary === 1;
          const initialRefusals = exceedsLimit ? 3 : 2;
          wire.command('storage.getBytes', args);
          await expect.poll(host.stderr).toContain('HELD\n');
          for (const _ of Array.from({ length: 30 })) wire.command('storage.getBytes', args);
          wire.command('storage.getBytes', readArgs(operationBytes + boundary));
          if (exceedsLimit) wire.command('storage.getBytes', args);
          wire.command('storage.deleteObject', { path });
          wire.checkpoint();
          await expect.poll(host.stderr).toContain('HTTP pipeline received');
          const healthy = await list();
          expect(healthy.stderr).toContain('hosted sandbox');
          expect(JSON.parse(healthy.stdout)).toMatchObject({ ok: true, data: { items: [path] } });
          // One settled call returns its bytes while the next read remains paused.
          host.child.kill('SIGUSR1');
          await expect.poll(firstPhaseReads).toBe(1);
          await expect.poll(() => host.stderr().split('HELD\n').length - 1).toBe(2);
          wire.command('storage.getBytes', args);
          wire.command('storage.deleteObject', { path });
          wire.checkpoint();
          await expect.poll(() => host.stderr().split('HTTP pipeline received\n').length - 1).toBe(2);
          if (failsReads) {
            // Direct commands execute serially: fail each read as it reaches I/O.
            for (const readCount of Array.from({ length: 32 }, (_, index) => index + 2)) {
              await expect.poll(() => host.stderr().split('HELD\n').length - 1, { intervals: [10, 25, 50] }).toBe(readCount);
              host.child.kill('SIGUSR1');
              await expect.poll(failed.count, { intervals: [10, 25, 50] }).toBe(readCount);
            }
          }
          host.child.kill('SIGUSR2');
          holding = false;
          await expect.poll(firstPhaseReads).toBe(33);
          await expect.poll(refused.count).toBe(initialRefusals);
          const intact = await list();
          expect(JSON.parse(intact.stdout)).toMatchObject({ ok: true, data: { items: [path] } });
          host.child.kill('SIGUSR2');
          holding = true;
          await expect.poll(host.stderr).toContain('ARMED\n');
          for (const _ of Array.from({ length: 32 })) wire.command('storage.getBytes', args);
          wire.command('storage.deleteObject', { path });
          wire.checkpoint();
          await expect.poll(() => host.stderr().split('HTTP pipeline received\n').length - 1).toBe(3);
          host.child.kill('SIGUSR2');
          holding = false;
          const afterRefillReads = failsReads ? 32 : 65;
          await expect.poll(completed.count).toBe(afterRefillReads);
          await expect.poll(refused.count).toBe(initialRefusals + 1);
          wire.finish();
          await wire.result();
          const afterRefill = await list();
          expect(JSON.parse(afterRefill.stdout)).toMatchObject({ ok: true, data: { items: [path] } });
        } finally {
          if (holding) host.child.kill('SIGUSR2');
          holding = false;
          await wire.close();
        }
      } finally {
        if (holding) host.child.kill('SIGUSR2');
        await host.stop();
      }
    } finally {
      await fixture.stop();
    }
  });
}
