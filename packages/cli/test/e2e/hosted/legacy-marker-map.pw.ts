import { test, expect } from '@playwright/test';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { startSoakServe } from '../soak/harness.js';

test('an unversioned consumer write retains a map shaped like a newer encoding marker', async ({ browser }) => {
  const serve = await startSoakServe({
    flags: ['--no-capture'],
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /places/legacy { allow read, write: if true; } } }",
      'index.html': '<button id="read" disabled>Read legacy map</button><output id="result">Starting</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        const readButton = document.querySelector('#read');
        readButton.addEventListener('click', async () => {
          try {
            const snapshot = await getDoc(doc(db, 'places', 'legacy'));
            result.textContent = JSON.stringify(snapshot.data().payload);
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
          }
        });
        readButton.disabled = false;
        result.textContent = 'Ready';
      `,
    },
  });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(serve.info.url);
    await expect(page.locator('#result')).toHaveText('Ready');
    const remote = await connectRemoteSandbox({ url: serve.info.url });
    try {
      await remote.channel.op({
        method: 'setDoc',
        path: 'places/legacy',
        data: { payload: { type: 'pyric/map/1.0', fields: { label: 'legacy data' } } },
      });
      await page.getByRole('button', { name: 'Read legacy map', exact: true }).click();
      await expect(page.locator('#result')).toHaveText('{"type":"pyric/map/1.0","fields":{"label":"legacy data"}}');
      expect(errors).toEqual([]);
    } finally {
      remote.close();
    }
  } finally {
    await context.close();
    await serve.stop();
  }
});
