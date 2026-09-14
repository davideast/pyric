import { readFileSync } from 'node:fs';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startSoakServe, waitForPeer } from '../soak/harness.js';
import { prepareRuntimeFixture } from './runtime-fixture.js';

const legacyBundle = JSON.stringify({
  format: 'pyric-v3-records',
  records: {
    meta: { version: 3, savedAt: 0, services: {} },
    '00': { docs: { 'shared/greeting': { message: 'Legacy document', literal: { type: 'user-map' } } } },
  },
});

const corruptCheckpoint = JSON.stringify({
  format: 'pyric-checkpoint-v1', at: 0,
  counts: { firestore: 0, database: 0, storage: 1, auth: 0 },
  state: {
    firestore: {}, database: null,
    storage: [{ path: 'files/broken.bin', contentBase64: 'not base64', customMetadata: {} }],
    auth: { users: [], providers: {} },
    rules: { firestore: '', database: null, storage: null },
  },
});

for (const mode of ['hosted', 'sharedworker'] as const) {
  test(`${mode} reads a legacy transfer and refuses a corrupt complete transfer without losing healthy state`, async ({ page }) => {
    test.setTimeout(30_000);
    const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
    const fixture = await startSoakServe({ flags, extraFiles: {
      'firestore.rules': 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /shared/{id} { allow read, write: if true; } } }',
      'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
      'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    } });
    try {
      await page.goto(fixture.info.url);
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
      await expect(page.locator('#document')).toHaveText('Empty');
      await waitForPeer(fixture.info.url);
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await expect(control.channel.op({ method: 'importState', bundle: legacyBundle })).resolves.toEqual({ ok: true });
        await expect(page.locator('#document')).toHaveText('Legacy document');
        await expect(control.channel.op({ method: 'importState', bundle: corruptCheckpoint })).rejects.toMatchObject({ code: 'invalid-argument' });
        const actual = await page.evaluate(async () => {
          const { doc, getDoc, getFirestore } = await import('firebase/firestore');
          return (await getDoc(doc(getFirestore(), 'shared/greeting'))).data();
        });
        expect(actual).toEqual({ message: 'Legacy document', literal: { type: 'user-map' } });
        await page.getByRole('button', { name: 'Write shared document' }).click();
        await expect(page.locator('#write-result')).toHaveText('Written');
        await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      } finally {
        control.close();
      }
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}
