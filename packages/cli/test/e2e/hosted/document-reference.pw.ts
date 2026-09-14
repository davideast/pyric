import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

test('a stored nested document reference can be followed by another browser', async ({ browser }) => {
  await followStoredReference(browser, ['--hosted', '--no-capture']);
});

test('SharedWorker preserves a stored reference across client pages', async ({ browser }) => {
  await followStoredReference(browser, ['--no-capture'], true);
});

async function followStoredReference(browser: Browser, flags: string[], shareProfile = false): Promise<void> {
  const serve = await startSoakServe({
    flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /authors/alice { allow read: if true; allow write: if request.resource.data.name == 'Alice'; } match /posts/first { allow read: if true; allow write: if request.resource.data.title == 'First post'; } } }",
      'index.html': '<button id="write">Write post</button><button id="read">Follow author</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        const db = getFirestore(app);
        const post = doc(db, 'posts', 'first');
        const result = document.querySelector('#result');
        document.querySelector('#write').addEventListener('click', async () => {
          try {
            const author = doc(db, 'authors', 'alice');
            await setDoc(author, { name: 'Alice' });
            await setDoc(post, { title: 'First post', details: { authors: [author] } });
            result.textContent = 'Written';
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
          }
        });
        document.querySelector('#read').addEventListener('click', async () => {
          try {
            const snapshot = await getDoc(post);
            const author = snapshot.data().details.authors[0];
            const authorSnapshot = await getDoc(author);
            result.textContent = author.path + ': ' + authorSnapshot.data().name;
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
          }
        });
      `,
    },
  });
  const writerContext = await browser.newContext();
  let readerContext = writerContext;
  const needsSeparateProfile = !shareProfile;
  if (needsSeparateProfile) readerContext = await browser.newContext();
  try {
    const writer = await writerContext.newPage();
    const reader = await readerContext.newPage();
    const pageErrors: string[] = [];
    writer.on('pageerror', (error) => pageErrors.push(error.message));
    reader.on('pageerror', (error) => pageErrors.push(error.message));
    await writer.goto(serve.info.url);
    await reader.goto(serve.info.url);
    await expect(writer.locator('#result')).toHaveText('Ready');
    await expect(reader.locator('#result')).toHaveText('Ready');

    await writer.getByRole('button', { name: 'Write post', exact: true }).click();
    await expect(writer.locator('#result')).toHaveText('Written');
    await reader.getByRole('button', { name: 'Follow author', exact: true }).click();
    await expect(reader.locator('#result')).toHaveText('authors/alice: Alice');
    expect(pageErrors).toEqual([]);
  } finally {
    await writerContext.close();
    if (needsSeparateProfile) await readerContext.close();
    await serve.stop();
  }
}
