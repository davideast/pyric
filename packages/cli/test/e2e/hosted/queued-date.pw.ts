import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const transports = [
  { name: 'hosted', flags: ['--hosted', '--no-capture'], inPage: false },
  { name: 'SharedWorker', flags: ['--no-capture'], inPage: false },
  { name: 'in-page', flags: ['--no-capture'], inPage: true },
];

const dates = [
  { name: 'Date values', millis: 12345, expected: '{"isTimestamp":true,"seconds":12,"nanoseconds":345000000,"millis":12345}' },
  { name: 'the first Firestore Date', millis: -62135596800000, expected: '{"isTimestamp":true,"seconds":-62135596800,"nanoseconds":0,"millis":-62135596800000}' },
  { name: 'the last Firestore Date', millis: 253402300799999, expected: '{"isTimestamp":true,"seconds":253402300799,"nanoseconds":999000000,"millis":253402300799999}' },
];

for (const transport of transports) {
  for (const writer of ['batch', 'transaction'] as const) {
    for (const date of dates) {
      test(`${transport.name} ${writer} captures ${date.name} when queued`, async ({ browser }) => {
        await captureDate(browser, { ...transport, ...date, writer });
      });
    }
  }
}

function commitDate(writer: 'batch' | 'transaction'): string {
  const write = 'writer.set(event, { when }); when.setTime(99999);';
  const isBatch = writer === 'batch';
  if (isBatch) return `const writer = writeBatch(db); ${write} await writer.commit();`;
  return `await runTransaction(db, async (writer) => { ${write} });`;
}

async function captureDate(browser: Browser, scenario: {
  flags: string[];
  inPage: boolean;
  writer: 'batch' | 'transaction';
  millis: number;
  expected: string;
}): Promise<void> {
  const serve = await startSoakServe({
    flags: scenario.flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /events/first { allow read: if true; allow write: if request.resource.data.when is timestamp; } } }",
      'index.html': '<button id="write">Save date</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, runTransaction, Timestamp, writeBatch } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        document.querySelector('#write').addEventListener('click', async () => {
          try {
            const when = new Date(${scenario.millis});
            const event = doc(db, 'events', 'first');
            ${commitDate(scenario.writer)}
            const restored = (await getDoc(event)).data().when;
            result.textContent = JSON.stringify({
              isTimestamp: restored instanceof Timestamp,
              seconds: restored.seconds,
              nanoseconds: restored.nanoseconds,
              millis: restored.toMillis(),
            });
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
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
    await expect(page.locator('#result')).toHaveText('Ready');
    await page.getByRole('button', { name: 'Save date', exact: true }).click();
    await expect(page.locator('#result')).toHaveText(scenario.expected);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
}
