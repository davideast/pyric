import { prepareRuntimeFixture } from './runtime-fixture.js';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

for (const mode of ['hosted', 'sharedworker'] as const) {
  for (const replacement of ['import', 'reset'] as const) {
    test(`${mode} transaction paused before ${replacement} retries against replacement state`, async ({ page }) => {
      test.setTimeout(30_000);
      const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
      const fixture = await startSoakServe({
        flags,
        extraFiles: {
          'firestore.rules': 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /shared/greeting { allow read, write: if true; } } }',
          'index.html': '<output id="ready"></output><output id="transaction"></output><ol id="reads"></ol><script type="module" src="/main.js"></script>',
          'main.js': `
            import { initializeApp } from 'firebase/app';
            import { doc, getFirestore, setDoc } from 'firebase/firestore';
            const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
            await setDoc(doc(getFirestore(app), 'shared/greeting'), { count: 10 });
            document.querySelector('#ready').textContent = 'Ready';
          `,
        },
      });
      try {
        await page.goto(fixture.info.url);
        await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
        await expect(page.locator('#ready')).toHaveText('Ready');
        await waitForPeer(fixture.info.url);
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
            const { doc, getFirestore, runTransaction, setDoc } = await import('firebase/firestore');
            const db = getFirestore();
            const reference = doc(db, 'shared/greeting');
            await setDoc(reference, { count: 1, obsolete: 'Must not return' });
            const release = Promise.withResolvers<void>();
            window.addEventListener('resume-transaction', () => release.resolve(), { once: true });
            let pausesFirstRead = true;
            const status = document.querySelector('#transaction');
            const hasNoStatus = status === null;
            if (hasNoStatus) throw new Error('Expected the transaction output');
            void runTransaction(db, async transaction => {
              const snapshot = await transaction.get(reference);
              const data = snapshot.data() ?? { count: 0 };
              const count = data.count;
              const hasInvalidCount = typeof count !== 'number';
              if (hasInvalidCount) throw new Error('Expected a numeric counter');
              const entry = document.createElement('li');
              entry.textContent = String(count);
              document.querySelector('#reads')?.append(entry);
              if (pausesFirstRead) {
                pausesFirstRead = false;
                status.textContent = 'Paused';
                await release.promise;
              }
              transaction.set(reference, { ...data, count: count + 1 });
            }).then(() => { status.textContent = 'Committed'; }, error => { status.textContent = error.code; });
          });
          await expect(page.locator('#transaction')).toHaveText('Paused');
          await expect(page.locator('#reads li')).toHaveText(['1']);
          const importsState = replacement === 'import';
          if (importsState) {
            await expect(control.channel.op({ method: 'importState', bundle })).resolves.toEqual({ ok: true });
          } else {
            await expect(control.channel.op({ method: 'resetAll' })).resolves.toEqual({ errors: [] });
          }
          await page.evaluate(() => window.dispatchEvent(new Event('resume-transaction')));
          await expect(page.locator('#transaction')).toHaveText('Committed');
          const replacedCount = importsState ? 10 : 0;
          await expect(page.locator('#reads li')).toHaveText(['1', String(replacedCount)]);
          const result = await page.evaluate(async () => {
            const { doc, getDoc, getFirestore } = await import('firebase/firestore');
            return (await getDoc(doc(getFirestore(), 'shared/greeting'))).data();
          });
          const expectedCount = importsState ? 11 : 1;
          expect(result).toEqual({ count: expectedCount });
        } finally {
          control.close();
        }
      } finally {
        await page.close();
        await fixture.stop();
      }
    });
  }
}
