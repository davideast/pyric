import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import type { Checkpoint } from 'pyric/sandbox/checkpoints';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

for (const mode of ['hosted', 'sharedworker', 'inpage'] as const) {
  test(`${mode} checkpoint restore retains the saved Storage object metadata`, async ({ page }) => {
    const flags = ['--no-capture'];
    const isHosted = mode === 'hosted';
    const isInpage = mode === 'inpage';
    if (isHosted) flags.push('--hosted');
    if (isInpage) flags.push('--inpage');
    const fixture = await startStoragePersistenceFixture(flags);
    try {
      await page.goto(fixture.info.url);
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
        await control.channel.op({ method: 'checkpoint', name: 'object' });
        await page.evaluate(async () => {
          const { getStorage, ref, uploadBytes } = await import('firebase/storage');
          await uploadBytes(ref(getStorage(), 'files/saved.bin'), Uint8Array.of(3));
          await uploadBytes(ref(getStorage(), 'files/extra.bin'), Uint8Array.of(4));
        });
        await control.channel.op({ method: 'restore', name: 'object' });
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

test('hosted restore accepts legacy Storage checkpoint records without generated metadata', async ({ page }) => {
  const fixture = await startStoragePersistenceFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await control.channel.op({ method: 'checkpoint', name: 'legacy' });
      const path = join(fixture.dir, '.pyric', 'state', 'checkpoints', 'legacy.json');
      const checkpoint: Checkpoint = JSON.parse(readFileSync(path, 'utf8'));
      checkpoint.state.storage = [{ path: 'files/legacy.bin', contentBase64: 'AID/',
        contentType: 'application/octet-stream', customMetadata: { version: 'legacy' } }];
      checkpoint.counts.storage = 1;
      writeFileSync(path, JSON.stringify(checkpoint));
      await control.channel.op({ method: 'restore', name: 'legacy' });
      const restored = await page.evaluate(async () => {
        const { getStorage, ref, getMetadata, getBytes } = await import('firebase/storage');
        const object = ref(getStorage(), 'files/legacy.bin');
        return { metadata: await getMetadata(object), bytes: Array.from(new Uint8Array(await getBytes(object))) };
      });
      expect(restored).toMatchObject({ bytes: [0, 128, 255], metadata: {
        fullPath: 'files/legacy.bin', contentType: 'application/octet-stream', customMetadata: { version: 'legacy' },
      } });
    } finally {
      control.close();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});
