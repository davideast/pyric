import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { prepareRuntimeFixture } from './runtime-fixture.js';

const modes = ['hosted', 'sharedworker', 'inpage'] as const;
for (const mode of modes) {
  test(`${mode} exposes count queries through the served SDK`, async ({ page }) => {
    const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#write')).toBeEnabled();
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
      const counts = await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        const db = sdk.getFirestore();
        const source = sdk.collection(db, 'counts');
        const first = sdk.doc(source, 'first');
        await sdk.setDoc(first, { selected: true });
        await sdk.setDoc(sdk.doc(source, 'second'), { selected: false });
        const original = await sdk.getCountFromServer(source);
        const filtered = await sdk.getCountFromServer(sdk.query(source, sdk.where('selected', '==', true)));
        await sdk.deleteDoc(first);
        const afterDeletion = await sdk.getCountFromServer(source);
        const auth = await import('firebase/auth');
        await auth.signOut(auth.getAuth());
        let deniedCode: unknown = null;
        try {
          await sdk.getCountFromServer(source);
        } catch (error) {
          const hasCode = typeof error === 'object' && error !== null && 'code' in error;
          if (hasCode) deniedCode = error.code;
        }
        return { original: original.data(), filtered: filtered.data(), afterDeletion: afterDeletion.data(), deniedCode };
      });
      expect(counts).toEqual({ original: { count: 2 }, filtered: { count: 1 }, afterDeletion: { count: 1 }, deniedCode: 'permission-denied' });
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await fixture.stop();
    }
  });
}
