import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const transports = [
  { name: 'hosted', flags: ['--hosted', '--no-capture'], inPage: false },
  { name: 'SharedWorker', flags: ['--no-capture'], inPage: false },
  { name: 'in-page', flags: ['--no-capture'], inPage: true },
];

for (const transport of transports) {
  for (const boundary of [
    { name: 'after', value: 'new Date(Date.UTC(10000, 0, 1))', message: 'Timestamp seconds out of range: 253402300800' },
    { name: 'before', value: 'new Date(-62135596800001)', message: 'Timestamp seconds out of range: -62135596801' },
  ]) {
    for (const writer of ['batch', 'transaction'] as const) {
      test(`${transport.name} ${writer} rejects a Date ${boundary.name} Firestore range before queuing it`, async ({ browser }) => {
        await rejectTimestamp(browser, { ...transport, ...boundary, writer });
      });
    }
  }

  for (const scenario of [
    { name: 'negative nanoseconds before checking seconds', value: 'new Timestamp(253402300800, -1)', message: 'Timestamp nanoseconds out of range: -1' },
    { name: 'nanoseconds equal to a second', value: 'new Timestamp(0, 1000000000)', message: 'Timestamp nanoseconds out of range: 1000000000' },
  ]) {
    test(`${transport.name} Timestamp rejects ${scenario.name}`, async ({ browser }) => {
      await rejectTimestamp(browser, { ...transport, ...scenario, writer: 'batch' });
    });
  }
}

function commitTimestamp(writer: 'batch' | 'transaction', value: string): string {
  const write = `writer.set(event, { when: ${value} }); stage = 'commit';`;
  const isBatch = writer === 'batch';
  if (isBatch) return `const writer = writeBatch(db); ${write} await writer.commit();`;
  return `await runTransaction(db, async (writer) => { ${write} });`;
}

async function rejectTimestamp(browser: Browser, scenario: {
  value: string;
  flags: string[];
  inPage: boolean;
  message: string;
  writer: 'batch' | 'transaction';
}): Promise<void> {
  const serve = await startSoakServe({
    flags: scenario.flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /events/{id} { allow read, write: if true; } } }",
      'index.html': '<button id="write">Save timestamp</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp, FirebaseError } from 'firebase/app';
        import { doc, getDoc, getFirestore, runTransaction, Timestamp, writeBatch } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        document.querySelector('#write').addEventListener('click', async () => {
          const event = doc(db, 'events', 'first');
          let stage = 'set';
          let code = 'none';
          let isFirebaseError = false;
          try {
            ${commitTimestamp(scenario.writer, scenario.value)}
            stage = 'committed';
          } catch (error) {
            code = error.code;
            isFirebaseError = error instanceof FirebaseError;
            result.dataset.errorMessage = error.message;
          }
          let exists = null;
          let readError;
          try {
            exists = (await getDoc(event)).exists();
          } catch (error) {
            readError = error.code;
          }
          result.textContent = JSON.stringify({ stage, code, isFirebaseError, exists, readError });
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
    await expect(page.locator('#result')).toHaveText('Ready');
    await page.getByRole('button', { name: 'Save timestamp', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('{"stage":"set","code":"invalid-argument","isFirebaseError":true,"exists":false}');
    await expect(page.locator('#result')).toHaveAttribute('data-error-message', scenario.message);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
}
