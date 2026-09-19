import { prepareRuntimeFixture } from './runtime-fixture.js';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

for (const mode of ['sharedworker'] as const) {
  test(`${mode} checkpoint keeps typed values distinct from literal marker maps`, async ({ page }) => {
    const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
    const fixture = await startStoragePersistenceFixture(flags);
    try {
      await page.goto(fixture.info.url);
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
      await expect(page.locator('#ready')).toHaveText('Ready');
      const setup = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await setup.channel.op({ method: 'setFirestoreRules', source:
          'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /{path=**} { allow read, write: if true; } } }' });
      } finally {
        setup.close();
      }
      await page.evaluate(async () => {
        const { Bytes, Timestamp, doc, getFirestore, setDoc } = await import('firebase/firestore');
        await setDoc(doc(getFirestore(), 'shared/values'), {
          timestamp: Timestamp.fromMillis(1700000000123), bytes: Bytes.fromUint8Array(Uint8Array.of(0, 128, 255)),
          literal: { __type: 'timestamp', seconds: 5, nanos: 0, note: 'ordinary map' },
        });
      });
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await control.channel.op({ method: 'checkpoint', name: 'values' });
        await control.channel.op({ method: 'restore', name: 'values' });
        const restored = await page.evaluate(async () => {
          const { doc, getDoc, getFirestore } = await import('firebase/firestore');
          const data = (await getDoc(doc(getFirestore(), 'shared/values'))).data();
          const isMissing = data === undefined;
          if (isMissing) throw new Error('Expected restored document');
          return { timestamp: data.timestamp.toMillis(), bytes: Array.from(data.bytes.toUint8Array()), literal: data.literal };
        });
        expect(restored).toEqual({ timestamp: 1700000000123, bytes: [0, 128, 255],
          literal: { __type: 'timestamp', seconds: 5, nanos: 0, note: 'ordinary map' } });
      } finally {
        control.close();
      }
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}
