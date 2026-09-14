import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const transports = [
  { name: 'hosted', flags: ['--hosted', '--no-capture'], inPage: false },
  { name: 'SharedWorker', flags: ['--no-capture'], inPage: false },
  { name: 'in-page', flags: ['--no-capture'], inPage: true },
];

const documents = [
  { name: 'existing', id: 'first', expected: '{"exists":true,"count":7,"path":"counters/first"}' },
  { name: 'missing', id: 'missing', expected: '{"exists":false,"path":"counters/missing"}' },
];

for (const transport of transports) {
  for (const document of documents) {
    test(`${transport.name} transaction reads return a modular snapshot for an ${document.name} document`, async ({ browser }) => {
      await readTransactionSnapshot(browser, { ...transport, ...document });
    });
  }
}

async function readTransactionSnapshot(browser: Browser, scenario: {
  flags: string[];
  inPage: boolean;
  id: string;
  expected: string;
}): Promise<void> {
  const serve = await startSoakServe({
    flags: scenario.flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /counters/{id} { allow read, write: if true; } } }",
      'index.html': '<button id="read">Read in transaction</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getFirestore, runTransaction, setDoc } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        document.querySelector('#read').addEventListener('click', async () => {
          try {
            const reference = doc(db, 'counters', 'first');
            await setDoc(reference, { count: 7 });
            const observed = await runTransaction(db, async (transaction) => {
              const snapshot = await transaction.get(doc(db, 'counters', '${scenario.id}'));
              return { exists: snapshot.exists(), count: snapshot.data()?.count, path: snapshot.ref.path };
            });
            result.textContent = JSON.stringify(observed);
          } catch (error) {
            result.textContent = error.name + ': ' + error.message;
          }
        });
      `,
    },
  });
  const context = await browser.newContext();
  try {
    const { inPage } = scenario;
    if (inPage) {
      await context.addInitScript(() => {
        Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
      });
    }
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(serve.info.url);
    await page.getByRole('button', { name: 'Read in transaction', exact: true }).click();
    await expect(page.locator('#result')).toHaveText(scenario.expected);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
}
