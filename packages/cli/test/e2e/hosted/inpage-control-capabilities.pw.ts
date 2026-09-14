import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { prepareRuntimeFixture } from './runtime-fixture.js';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

test('in-page SDK data remains intact when unavailable worker controls are refused', async ({ page }) => {
  test.setTimeout(30_000);
  const { flags, expectedMode } = await prepareRuntimeFixture(page, 'inpage');
  const fixture = await startStoragePersistenceFixture(flags);
  try {
    await page.goto(fixture.info.url);
    await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.evaluate(async () => {
      const { getAuth, signInAnonymously } = await import('firebase/auth');
      const { Bytes, Timestamp, doc, getFirestore, setDoc } = await import('firebase/firestore');
      const { getStorage, ref, uploadBytes } = await import('firebase/storage');
      await signInAnonymously(getAuth());
      await setDoc(doc(getFirestore(), 'shared/values'), {
        timestamp: Timestamp.fromMillis(1700000000123),
        bytes: Bytes.fromUint8Array(Uint8Array.of(0, 128, 255)),
        literal: { __type: 'timestamp', seconds: 5, nanos: 0, note: 'ordinary map' },
      });
      await uploadBytes(ref(getStorage(), 'files/saved.bin'), Uint8Array.of(0, 128, 255), {
        contentType: 'application/octet-stream', customMetadata: { version: 'saved' },
      });
    });
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      const operations = [
        { method: 'checkpoint', name: 'unavailable' },
        { method: 'restore', name: 'unavailable' },
        { method: 'exportState' },
        { method: 'importState', bundle: '{}' },
        { method: 'resetAll' },
      ] as const;
      for (const operation of operations) {
        await expect(control.channel.op(operation)).rejects.toMatchObject({ code: 'unimplemented' });
      }
      const result = await page.evaluate(async () => {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        const { getBytes, getMetadata, getStorage, ref } = await import('firebase/storage');
        const data = (await getDoc(doc(getFirestore(), 'shared/values'))).data();
        const isMissing = data === undefined;
        if (isMissing) throw new Error('Expected the original document');
        const object = ref(getStorage(), 'files/saved.bin');
        return {
          timestamp: data.timestamp.toMillis(), bytes: Array.from(data.bytes.toUint8Array()), literal: data.literal,
          storageBytes: Array.from(new Uint8Array(await getBytes(object))), metadata: await getMetadata(object),
        };
      });
      expect(result).toMatchObject({
        timestamp: 1700000000123, bytes: [0, 128, 255],
        literal: { __type: 'timestamp', seconds: 5, nanos: 0, note: 'ordinary map' },
        storageBytes: [0, 128, 255], metadata: { contentType: 'application/octet-stream', customMetadata: { version: 'saved' } },
      });
    } finally {
      control.close();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});
