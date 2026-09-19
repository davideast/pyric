import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const allEvents = '[{"id":"boundary","nanoseconds":0},{"id":"early","nanoseconds":0},{"id":"late","nanoseconds":0}]';
const transports = [
  { name: 'hosted', flags: ['--hosted', '--no-capture'], inPage: false },
  { name: 'SharedWorker', flags: ['--no-capture'], inPage: false },
  { name: 'in-page', flags: ['--no-capture'], inPage: true },
];
const queries = [
  { name: 'startAt', constraints: "orderBy('when'), startAt(new Timestamp(12, 5))", expected: allEvents },
  { name: 'startAfter', constraints: "orderBy('when'), startAfter(new Timestamp(12, 5))", expected: '[]' },
  { name: 'endAt', constraints: "orderBy('when'), endAt(new Timestamp(12, 5))", expected: allEvents },
  { name: 'endBefore', constraints: "orderBy('when'), endBefore(new Timestamp(12, 5))", expected: '[]' },
  { name: 'equality', constraints: "where('when', '==', new Timestamp(12, 5))", expected: allEvents },
];

for (const transport of transports) {
  for (const scenario of queries) {
    test(`${transport.name} ${scenario.name} uses Firestore timestamp precision`, async ({ browser }) => {
      await timestampQuery(browser, { ...transport, ...scenario });
    });
  }
}

async function timestampQuery(browser: Browser, scenario: {
  flags: string[];
  inPage: boolean;
  constraints: string;
  expected: string;
}): Promise<void> {
  const serve = await startSoakServe({
    flags: scenario.flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /events/{id} { allow read: if true; allow write: if request.resource.data.when is timestamp; } } }",
      'index.html': '<button id="query">Find events</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { collection, doc, getDocs, getFirestore, endAt, endBefore, orderBy, query, setDoc, startAfter, startAt, Timestamp, where } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        document.querySelector('#query').addEventListener('click', async () => {
          try {
            await setDoc(doc(db, 'events', 'late'), { when: new Timestamp(12, 9) });
            await setDoc(doc(db, 'events', 'early'), { when: new Timestamp(12, 2) });
            await setDoc(doc(db, 'events', 'boundary'), { when: new Timestamp(12, 5) });
            const events = query(collection(db, 'events'), ${scenario.constraints});
            const snapshot = await getDocs(events);
            result.textContent = JSON.stringify(snapshot.docs.map((event) => ({
              id: event.id,
              nanoseconds: event.data().when.nanoseconds,
            })));
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
    await page.getByRole('button', { name: 'Find events', exact: true }).click();
    await expect(page.locator('#result')).toHaveText(scenario.expected);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
}
