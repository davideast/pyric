import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { nestedDocument, type DocumentShape } from './document-depth-fixture.js';

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode} enforces encoded document depth across SDK write families`, async ({ page }) => {
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
        for (const depth of [63, 64, 65, 256]) {
          const data = nestedDocument(depth, shape);
          await test.step(`${shape}: ${depth} encoded containers`, async () => {
            const outcome = await page.evaluate(async (dataJson) => {
              const data = JSON.parse(dataJson);
              const sdk = await import('firebase/firestore');
              const target = sdk.doc(sdk.getFirestore(), 'limits/value');
              await sdk.setDoc(target, { original: true });
              let failure: { code: unknown; message: string } | null = null;
              try {
                await sdk.setDoc(target, data);
              } catch (error) {
                const isError = error instanceof Error;
                const hasCode = typeof error === 'object' && error !== null && 'code' in error;
                failure = {
                  code: hasCode ? error.code : null,
                  message: isError ? error.message : 'Non-Error rejection',
                };
              }
              const restored = (await sdk.getDoc(target)).data();
              return { failure, restored };
            }, JSON.stringify(data));
            const exceedsDepth = depth > 64;
            if (exceedsDepth) {
              expect(outcome.failure).toEqual({
                code: 'invalid-argument',
                message: 'Encoded document nesting exceeds 64 containers.',
              });
              expect(outcome.restored).toEqual({ original: true });
            } else {
              expect(outcome.failure).toBeNull();
              expect(outcome.restored).toEqual(data);
            }
          });
        }
      }
      for (const method of ['update', 'add', 'batch', 'transaction']) {
        await test.step(`${method} refuses without partial writes`, async () => {
          const outcome = await page.evaluate(async ({ data, method }) => {
            const sdk = await import('firebase/firestore');
            const db = sdk.getFirestore();
            const target = sdk.doc(db, 'limits/value');
            const companion = sdk.doc(db, 'limits/companion');
            const additions = sdk.collection(db, 'depth-additions');
            await sdk.setDoc(target, { original: true });
            await sdk.setDoc(companion, { original: true });
            let failure: { code: unknown; message: string } | null = null;
            try {
              const isUpdate = method === 'update';
              const isAdd = method === 'add';
              const isBatch = method === 'batch';
              if (isUpdate) await sdk.updateDoc(target, data);
              else if (isAdd) await sdk.addDoc(additions, data);
              else if (isBatch) {
                const batch = sdk.writeBatch(db);
                batch.set(companion, { changed: true });
                batch.set(target, data);
                await batch.commit();
              } else {
                await sdk.runTransaction(db, async transaction => {
                  transaction.set(companion, { changed: true });
                  transaction.set(target, data);
                });
              }
            } catch (error) {
              const isError = error instanceof Error;
              const hasCode = typeof error === 'object' && error !== null && 'code' in error;
              failure = {
                code: hasCode ? error.code : null,
                message: isError ? error.message : 'Non-Error rejection',
              };
            }
            return {
              failure,
              target: (await sdk.getDoc(target)).data(),
              companion: (await sdk.getDoc(companion)).data(),
              additions: (await sdk.getDocs(additions)).size,
            };
          }, { data: nestedDocument(65, 'maps'), method });
          expect(outcome).toEqual({
            failure: { code: 'invalid-argument', message: 'Encoded document nesting exceeds 64 containers.' },
            target: { original: true },
            companion: { original: true },
            additions: 0,
          });
        });
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
