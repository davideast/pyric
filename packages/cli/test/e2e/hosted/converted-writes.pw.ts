import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const transports = [
  { name: 'hosted', flags: ['--hosted', '--no-capture'], inPage: false },
  { name: 'SharedWorker', flags: ['--no-capture'], inPage: false },
  { name: 'in-page', flags: ['--no-capture'], inPage: true },
];

const operations = [
  { name: 'setDoc', body: 'await setDoc(reference, model);' },
  { name: 'batch set', body: `
    const batch = writeBatch(db);
    batch.set(reference, model);
    await batch.commit();
  ` },
  { name: 'transaction set', body: `
    await runTransaction(db, async (transaction) => {
      transaction.set(reference, model);
    });
  ` },
];

for (const transport of transports) {
  for (const operation of operations) {
    test(`${transport.name} ${operation.name} converts the model before write rules and storage`, async ({ browser }) => {
      await writeModel(browser, transport, operation.body);
    });
  }
}

async function writeModel(browser: Browser, transport: { flags: string[]; inPage: boolean }, write: string): Promise<void> {
  const serve = await startSoakServe({
    flags: transport.flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /users/{id} { allow read: if true; allow write: if request.resource.data.storedName == 'Ada'; } } }",
      'index.html': '<button id="write">Write model</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, setDoc, writeBatch, runTransaction } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        document.querySelector('#write').addEventListener('click', async () => {
          try {
            const rawReference = doc(db, 'users/first');
            const reference = rawReference.withConverter({
              toFirestore: (model) => ({ storedName: model.label }),
              fromFirestore: (snapshot) => ({ label: snapshot.data().storedName }),
            });
            const model = { label: 'Ada' };
            ${write}
            const stored = (await getDoc(rawReference)).data();
            result.textContent = JSON.stringify(stored);
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
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
    await page.getByRole('button', { name: 'Write model', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('{"storedName":"Ada"}');
  } finally {
    await context.close();
    await serve.stop();
  }
}
