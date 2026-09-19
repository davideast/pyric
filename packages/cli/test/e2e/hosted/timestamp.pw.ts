import { test, expect } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

for (const transport of [
  { name: 'hosted', flags: ['--hosted', '--no-capture'], inPage: false },
  { name: 'SharedWorker', flags: ['--no-capture'], inPage: false },
  { name: 'in-page', flags: ['--no-capture'], inPage: true },
]) {
  test(`a ${transport.name} timestamp uses Firestore storage precision`, async ({ browser }) => {
    const serve = await startSoakServe({
      flags: transport.flags,
      extraFiles: {
        'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /events/first { allow read: if true; allow write: if request.resource.data.when is timestamp && request.resource.data.when.nanos() == 345678000; } } }",
        'index.html': '<button id="write">Save timestamp</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
        'main.js': `
          import { initializeApp } from 'firebase/app';
          import { doc, getDoc, getFirestore, setDoc, Timestamp } from 'firebase/firestore';
          const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
          const result = document.querySelector('#result');
          document.querySelector('#write').addEventListener('click', async () => {
            try {
              const original = new Timestamp(12, 345678900);
              const event = doc(db, 'events', 'first');
              await setDoc(event, { when: original });
              const snapshot = await getDoc(event);
              const restored = snapshot.data().when;
              result.textContent = JSON.stringify({
                isTimestamp: restored instanceof Timestamp,
                seconds: restored.seconds,
                nanoseconds: restored.nanoseconds,
                millis: restored.toMillis(),
                equal: restored.isEqual(original),
                originalNanoseconds: original.nanoseconds,
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
      await expect(page.locator('#result')).toHaveText('Ready');
      await page.getByRole('button', { name: 'Save timestamp', exact: true }).click();
      await expect(page.locator('#result')).toHaveText('{"isTimestamp":true,"seconds":12,"nanoseconds":345678000,"millis":12345.678,"equal":false,"originalNanoseconds":345678900}');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await serve.stop();
    }
  });
}
