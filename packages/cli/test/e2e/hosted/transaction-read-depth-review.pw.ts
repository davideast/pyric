import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { nestedDocument, type DocumentShape } from './document-depth-fixture.js';

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode} transactions read documents at the depth limit without phantom conflicts`, async ({ page }) => {
    const flags = ['--no-capture'];
    const usesHostedRuntime = mode === 'hosted';
    if (usesHostedRuntime) flags.push('--hosted');
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
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(mode);
      const shapes: DocumentShape[] = ['maps', 'arrays', 'escaped'];
      for (const shape of shapes) {
        for (const depth of [63, 64]) {
          const data = nestedDocument(depth, shape);
          await test.step(`${shape}: ${depth} encoded containers`, async () => {
            const outcome = await page.evaluate(async dataJson => {
              const data = JSON.parse(dataJson);
              const sdk = await import('firebase/firestore');
              const db = sdk.getFirestore();
              const target = sdk.doc(db, 'limits/value');
              const companion = sdk.doc(db, 'limits/companion');
              await sdk.setDoc(target, data);
              await sdk.setDoc(companion, { committed: false });
              let attempts = 0;
              const observedJson = await sdk.runTransaction(db, async transaction => {
                attempts += 1;
                const snapshot = await transaction.get(target);
                transaction.set(companion, { committed: true });
                return JSON.stringify(snapshot.data());
              });
              return {
                attempts,
                observedJson,
                committed: (await sdk.getDoc(companion)).data(),
                originalJson: JSON.stringify((await sdk.getDoc(target)).data()),
              };
            }, JSON.stringify(data));
            expect(outcome.attempts).toBe(1);
            expect(JSON.parse(outcome.observedJson)).toEqual(data);
            expect(JSON.parse(outcome.originalJson)).toEqual(data);
            expect(outcome.committed).toEqual({ committed: true });
          });
        }
      }
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await fixture.stop();
    }
  });
}
