import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

test('a reference equality query selects the matching author', async ({ browser }) => {
  await findAuthorPosts(browser, ['--hosted', '--no-capture']);
});

test('SharedWorker reference queries preserve value identity', async ({ browser }) => {
  await findAuthorPosts(browser, ['--no-capture']);
});

async function findAuthorPosts(browser: Browser, flags: string[]): Promise<void> {
  const serve = await startSoakServe({
    flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /posts/{id} { allow read: if true; allow write: if request.resource.data.title is string; } } }",
      'index.html': '<button id="query">Find Alice posts</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { collection, doc, getDocs, getFirestore, query, setDoc, where } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        const db = getFirestore(app);
        const result = document.querySelector('#result');
        document.querySelector('#query').addEventListener('click', async () => {
          try {
            await setDoc(doc(db, 'posts', 'alice-post'), { title: 'Alice post', author: doc(db, 'authors', 'alice') });
            await setDoc(doc(db, 'posts', 'bob-post'), { title: 'Bob post', author: doc(db, 'authors', 'bob') });
            const posts = query(collection(db, 'posts'), where('author', '==', doc(db, 'authors', 'alice')));
            const snapshot = await getDocs(posts);
            result.textContent = JSON.stringify(snapshot.docs.map((post) => ({ id: post.id, author: post.data().author.path })));
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
    await page.getByRole('button', { name: 'Find Alice posts', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('[{"id":"alice-post","author":"authors/alice"}]');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
}
