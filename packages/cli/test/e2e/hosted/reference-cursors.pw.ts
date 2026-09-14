import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

for (const transport of [
  { name: 'hosted', flags: ['--hosted', '--no-capture'] },
  { name: 'SharedWorker', flags: ['--no-capture'] },
]) {
  test(`${transport.name} startAt includes its reference boundary`, async ({ browser }) => {
    await findReferenceRange(browser, transport.flags, 'startAt', '[{"id":"boundary","author":"authors/b"},{"id":"late","author":"authors/c"}]');
  });

  test(`${transport.name} startAfter excludes its reference boundary`, async ({ browser }) => {
    await findReferenceRange(browser, transport.flags, 'startAfter', '[{"id":"late","author":"authors/c"}]');
  });

  test(`${transport.name} endAt includes its reference boundary`, async ({ browser }) => {
    await findReferenceRange(browser, transport.flags, 'endAt', '[{"id":"early","author":"authors/a"},{"id":"boundary","author":"authors/b"}]');
  });

  test(`${transport.name} endBefore excludes its reference boundary`, async ({ browser }) => {
    await findReferenceRange(browser, transport.flags, 'endBefore', '[{"id":"early","author":"authors/a"}]');
  });
}

async function findReferenceRange(
  browser: Browser,
  flags: string[],
  cursor: 'startAt' | 'startAfter' | 'endAt' | 'endBefore',
  expected: string,
): Promise<void> {
  const serve = await startSoakServe({
    flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /events/{id} { allow read: if true; allow write: if request.resource.data.author is reference; } } }",
      'index.html': '<button id="query">Find events</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { collection, doc, getDocs, getFirestore, orderBy, query, setDoc, ${cursor} } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        document.querySelector('#query').addEventListener('click', async () => {
          try {
            await setDoc(doc(db, 'events', 'late'), { author: doc(db, 'authors', 'c') });
            await setDoc(doc(db, 'events', 'early'), { author: doc(db, 'authors', 'a') });
            await setDoc(doc(db, 'events', 'boundary'), { author: doc(db, 'authors', 'b') });
            const events = query(collection(db, 'events'), orderBy('author'), ${cursor}(doc(db, 'authors', 'b')));
            const snapshot = await getDocs(events);
            result.textContent = JSON.stringify(snapshot.docs.map((event) => ({
              id: event.id,
              author: event.data().author.path,
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
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(serve.info.url);
    await expect(page.locator('#result')).toHaveText('Ready');
    await page.getByRole('button', { name: 'Find events', exact: true }).click();
    await expect(page.locator('#result')).toHaveText(expected);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
}
