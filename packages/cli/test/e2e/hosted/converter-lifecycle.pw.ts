import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

for (const transport of [
  { name: 'in-page', flags: ['--no-capture'], inPage: true },
  { name: 'hosted', flags: ['--hosted', '--no-capture'], inPage: false },
  { name: 'SharedWorker', flags: ['--no-capture'], inPage: false },
]) {
  test(`${transport.name} document converters can be removed and reapplied without changing the original reference`, async ({ browser }) => {
    await converterLifecycle(browser, transport);
  });
}

async function converterLifecycle(browser: Browser, transport: { flags: string[]; inPage: boolean }): Promise<void> {
  const serve = await startSoakServe({
    flags: transport.flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /users/{id} { allow read, write: if true; } } }",
      'index.html': '<button id="read">Read models</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        document.querySelector('#read').addEventListener('click', async () => {
          try {
            const reference = doc(db, 'users/first');
            await setDoc(reference, { storedName: 'Ada' });
            const converter = {
              toFirestore: (model) => ({ storedName: model.label }),
              fromFirestore: (snapshot) => ({ label: snapshot.data().storedName.toUpperCase() }),
            };
            const original = reference.withConverter(converter);
            const stripped = original.withConverter(null);
            const restored = stripped.withConverter(converter);
            const raw = (await getDoc(stripped)).data();
            const converted = (await getDoc(original)).data();
            const reapplied = (await getDoc(restored)).data();
            result.textContent = JSON.stringify({ raw, converted, reapplied });
          } catch (error) {
            result.textContent = error.name + ': ' + error.message;
          }
        });
      `,
    },
  });
  const context = await browser.newContext();
  try {
    const { inPage } = transport;
    if (inPage) {
      await context.addInitScript(() => {
        Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
      });
    }
    const page = await context.newPage();
    await page.goto(serve.info.url);
    await page.getByRole('button', { name: 'Read models', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('{"raw":{"storedName":"Ada"},"converted":{"label":"ADA"},"reapplied":{"label":"ADA"}}');
  } finally {
    await context.close();
    await serve.stop();
  }
}
