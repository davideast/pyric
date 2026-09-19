import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const transports = [
  { name: 'hosted', flags: ['--hosted', '--no-capture'], inPage: false },
  { name: 'SharedWorker', flags: ['--no-capture'], inPage: false },
  { name: 'in-page', flags: ['--no-capture'], inPage: true },
];

const inputs = [
  { name: 'numeric document data', reference: 'invalid', data: '42' },
  { name: 'numeric converter output', reference: 'invalid.withConverter({ toFirestore: () => 42, fromFirestore: (snapshot) => snapshot.data() })', data: '42' },
  { name: 'null document data', reference: 'invalid', data: 'null' },
  { name: 'array document data', reference: 'invalid', data: '[42]' },
  { name: 'class document data', reference: 'invalid', data: 'new (class Model { marker = "invalid"; })()' },
];

const operations = [
  { name: 'batch', execute: `
    const batch = writeBatch(db);
    const code = await queueWrites(batch);
    await batch.commit();
  ` },
  { name: 'transaction', execute: 'const code = await runTransaction(db, queueWrites);' },
];

for (const transport of transports) {
  for (const operation of operations) {
    for (const input of inputs) {
      test(`${transport.name} ${operation.name} rejects ${input.name} before queuing and preserves prior writes`, async ({ browser }) => {
        await rejectDocumentInput(browser, transport, operation.execute, input);
      });
    }
  }
}

async function rejectDocumentInput(browser: Browser, transport: { flags: string[]; inPage: boolean }, execute: string, input: { reference: string; data: string }): Promise<void> {
  const serve = await startSoakServe({
    flags: transport.flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /items/{id} { allow read, write: if true; } } }",
      'index.html': '<button id="write">Write documents</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, writeBatch, runTransaction } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        document.querySelector('#write').addEventListener('click', async () => {
          try {
            const valid = doc(db, 'items/valid');
            const invalid = doc(db, 'items/invalid');
            const queueWrites = async (writer) => {
              writer.set(valid, { marker: 'kept' });
              let code = 'accepted';
              try {
                writer.set(${input.reference}, ${input.data});
              } catch (error) {
                code = error.code;
              }
              return code;
            };
            ${execute}
            const kept = (await getDoc(valid)).data();
            const invalidExists = (await getDoc(invalid)).exists();
            result.textContent = JSON.stringify({ code, kept, invalidExists });
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
    await page.getByRole('button', { name: 'Write documents', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('{"code":"invalid-argument","kept":{"marker":"kept"},"invalidExists":false}');
  } finally {
    await context.close();
    await serve.stop();
  }
}
