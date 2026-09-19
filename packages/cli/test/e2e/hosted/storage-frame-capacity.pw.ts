import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { waitForPeer } from '../soak/harness.js';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode} preserves the 8 MiB Storage round trip within the frame limit`, async ({ page }) => {
    test.setTimeout(30_000);
    const flags = ['--no-capture'];
    const usesHostedRuntime = mode === 'hosted';
    if (usesHostedRuntime) flags.push('--hosted');
    const fixture = await startStoragePersistenceFixture(flags);
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#ready')).toHaveText('Ready');
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(mode);
      const result = await page.evaluate(async () => {
        const { getStorage, ref, uploadBytes, getBytes } = await import('firebase/storage');
        const target = ref(getStorage(), 'files/maximum.bin');
        const bytes = new Uint8Array(8 * 1024 * 1024).fill(0xab);
        await uploadBytes(target, bytes, { contentType: 'application/octet-stream' });
        const restored = new Uint8Array(await getBytes(target));
        return { size: restored.byteLength, matches: restored.every(value => value === 0xab) };
      });
      expect(result).toEqual({ size: 8 * 1024 * 1024, matches: true });
      await waitForPeer(fixture.info.url);
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        const bytes = await control.storage.getBytes('files/maximum.bin');
        expect(bytes.byteLength).toBe(8 * 1024 * 1024);
        expect(bytes.every(value => value === 0xab)).toBe(true);
      } finally {
        control.close();
      }
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await fixture.stop();
    }
  });
}
