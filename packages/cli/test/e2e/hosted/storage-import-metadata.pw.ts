import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { prepareRuntimeFixture } from './runtime-fixture.js';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

for (const mode of ['hosted', 'sharedworker'] as const) {
  test(`${mode} portable import restores Storage bytes and metadata and removes later objects`, async ({ page }) => {
    test.setTimeout(30_000);
    const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
    const fixture = await startStoragePersistenceFixture(flags);
    try {
      await page.goto(fixture.info.url);
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
      await expect(page.locator('#ready')).toHaveText('Ready');
      const saved = await page.evaluate(async () => {
        const { getStorage, ref, uploadBytes } = await import('firebase/storage');
        const object = ref(getStorage(), 'files/saved.bin');
        const result = await uploadBytes(object, Uint8Array.of(0, 128, 255), {
          contentType: 'application/octet-stream', customMetadata: { version: 'saved' }, cacheControl: 'private',
        });
        return result.metadata;
      });
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        const exported = await control.channel.op({ method: 'exportState' });
        const hasBundle = typeof exported === 'object' && exported !== null && 'bundle' in exported;
        const isMissingBundle = !hasBundle;
        if (isMissingBundle) throw new Error('Expected an exported state bundle');
        const bundle = exported.bundle;
        const isInvalidBundle = typeof bundle !== 'string';
        if (isInvalidBundle) throw new Error('Expected a string state bundle');
        await page.evaluate(async () => {
          const { getStorage, ref, uploadBytes } = await import('firebase/storage');
          await uploadBytes(ref(getStorage(), 'files/saved.bin'), Uint8Array.of(3));
          await uploadBytes(ref(getStorage(), 'files/extra.bin'), Uint8Array.of(4));
        });
        await expect(control.channel.op({ method: 'importState', bundle })).resolves.toEqual({ ok: true });
        const restored = await page.evaluate(async () => {
          const { getStorage, ref, getMetadata, getBytes, listAll } = await import('firebase/storage');
          const storage = getStorage();
          const object = ref(storage, 'files/saved.bin');
          return { metadata: await getMetadata(object),
            bytes: Array.from(new Uint8Array(await getBytes(object))),
            paths: (await listAll(ref(storage, 'files'))).items.map(item => item.fullPath) };
        });
        expect(restored).toEqual({ metadata: saved, bytes: [0, 128, 255], paths: ['files/saved.bin'] });
      } finally {
        control.close();
      }
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}
