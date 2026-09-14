import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

for (const mode of ['hosted', 'sharedworker'] as const) {
  test(`${mode} reset updates both active apps without reviving an unsubscribed listener`, async ({ browser }) => {
    test.setTimeout(30_000);
    const flags = ['--no-capture'];
    const isHosted = mode === 'hosted';
    if (isHosted) flags.push('--hosted');
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'firestore.rules': 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /shared/greeting { allow read, write: if true; } } }',
        'index.html': '<output id="current"></output><output id="removable"></output><output id="error"></output><button id="stop">Stop secondary listener</button><script type="module" src="/main.js"></script>',
        'main.js': `
          import { initializeApp } from 'firebase/app';
          import { doc, getFirestore, onSnapshot } from 'firebase/firestore';
          const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
          const reference = doc(getFirestore(app), 'shared/greeting');
          onSnapshot(reference, snapshot => {
            document.querySelector('#current').textContent = snapshot.data()?.message ?? 'Missing';
          }, error => { document.querySelector('#error').textContent = error.code; });
          const stop = onSnapshot(reference, snapshot => {
            document.querySelector('#removable').textContent = snapshot.data()?.message ?? 'Missing';
          });
          document.querySelector('#stop').addEventListener('click', stop);
        `,
      },
    });
    const writerContext = await browser.newContext();
    let observerContext = writerContext;
    if (isHosted) observerContext = await browser.newContext();
    try {
      const writer = await writerContext.newPage();
      const observer = await observerContext.newPage();
      for (const page of [writer, observer]) {
        await page.goto(fixture.info.url);
        await expect(page.locator('#current')).toHaveText('Missing');
      }
      await writer.evaluate(async () => {
        const { doc, getFirestore, setDoc } = await import('firebase/firestore');
        await setDoc(doc(getFirestore(), 'shared/greeting'), { message: 'Before reset' });
      });
      for (const page of [writer, observer]) {
        await expect(page.locator('#current')).toHaveText('Before reset');
        await expect(page.locator('#removable')).toHaveText('Before reset');
      }
      await writer.getByRole('button', { name: 'Stop secondary listener' }).click();
      // An SDK read on this app's port confirms its preceding unsubscribe was processed.
      expect(await writer.evaluate(async () => {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        return (await getDoc(doc(getFirestore(), 'shared/greeting'))).data()?.message;
      })).toBe('Before reset');
      await waitForPeer(fixture.info.url);
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await expect(control.channel.op({ method: 'resetAll' })).resolves.toEqual({ errors: [] });
        for (const page of [writer, observer]) {
          await expect(page.locator('#current')).toHaveText('Missing');
          await expect(page.locator('#error')).toBeEmpty();
        }
        await expect(observer.locator('#removable')).toHaveText('Missing');
        await writer.evaluate(async () => {
          const { doc, getFirestore, setDoc } = await import('firebase/firestore');
          await setDoc(doc(getFirestore(), 'shared/greeting'), { message: 'After reset' });
        });
        for (const page of [writer, observer]) {
          await expect(page.locator('#current')).toHaveText('After reset');
        }
        await expect(observer.locator('#removable')).toHaveText('After reset');
        await expect(writer.locator('#removable')).toHaveText('Before reset');
      } finally {
        control.close();
      }
    } finally {
      await Promise.all([writerContext.close(), observerContext.close()]);
      await fixture.stop();
    }
  });
}
