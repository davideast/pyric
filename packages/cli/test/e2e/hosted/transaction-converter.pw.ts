import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const transports = [
  { name: 'hosted', flags: ['--hosted', '--no-capture'], inPage: false },
  { name: 'SharedWorker', flags: ['--no-capture'], inPage: false },
  { name: 'in-page', flags: ['--no-capture'], inPage: true },
];

for (const transport of transports) {
  test(`${transport.name} transaction reads apply the document converter`, async ({ browser }) => {
    await readModel(browser, transport);
  });
}

test('hosted transaction snapshot references retain the converter for a following read', async ({ browser }) => {
  await readModel(browser, { flags: ['--hosted', '--no-capture'], inPage: false }, true);
});

function readOperation(followReference: boolean): string {
  if (followReference) {
    return `
      const snapshot = await runTransaction(db, (transaction) => transaction.get(modelReference));
      const model = (await getDoc(snapshot.ref)).data();
    `;
  }
  return `
    const model = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(modelReference);
      return snapshot.data();
    });
  `;
}

async function readModel(browser: Browser, transport: { flags: string[]; inPage: boolean }, followReference = false): Promise<void> {
  const serve = await startSoakServe({
    flags: transport.flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /users/{id} { allow read, write: if true; } } }",
      'index.html': '<button id="read">Read model</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, runTransaction, setDoc } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        document.querySelector('#read').addEventListener('click', async () => {
          try {
            const reference = doc(db, 'users', 'first');
            await setDoc(reference, { storedName: 'Ada' });
            const modelReference = reference.withConverter({
              toFirestore: (model) => ({ storedName: model.label }),
              fromFirestore: (snapshot) => ({ label: snapshot.data().storedName.toUpperCase() }),
            });
            ${readOperation(followReference)}
            result.textContent = JSON.stringify(model);
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
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(serve.info.url);
    await page.getByRole('button', { name: 'Read model', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('{"label":"ADA"}');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
}
