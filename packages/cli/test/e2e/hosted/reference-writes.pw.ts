import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

for (const transport of [
  { name: 'hosted', flags: ['--hosted', '--no-capture'], inPage: false },
  { name: 'SharedWorker', flags: ['--no-capture'], inPage: false },
  { name: 'in-page', flags: ['--no-capture'], inPage: true },
]) {
  test.describe(transport.name, () => {
    test('a reference returned by addDoc can be stored and followed', async ({ browser }) => {
      await followWrittenReference(browser, `
        const author = await addDoc(collection(db, 'authors'), { name: 'Alice' });
        const post = doc(db, 'posts', 'first');
        await setDoc(post, { author });
        return post;
      `, transport.flags, transport.inPage);
    });

    test('addDoc stores a reference field with its Firestore value type', async ({ browser }) => {
      await followWrittenReference(browser, `
        const author = doc(db, 'authors', 'alice');
        await setDoc(author, { name: 'Alice' });
        return addDoc(collection(db, 'posts'), { author });
      `, transport.flags, transport.inPage);
    });

    test('updateDoc replaces a reference field without losing its value type', async ({ browser }) => {
      await followWrittenReference(browser, `
        const author = doc(db, 'authors', 'alice');
        await setDoc(author, { name: 'Alice' });
        const post = doc(db, 'posts', 'first');
        await setDoc(post, { author: doc(db, 'authors', 'missing') });
        await updateDoc(post, { author });
        return post;
      `, transport.flags, transport.inPage);
    });

    test('batch set stores a reference field with its Firestore value type', async ({ browser }) => {
      await followWrittenReference(browser, `
        const author = doc(db, 'authors', 'alice');
        await setDoc(author, { name: 'Alice' });
        const post = doc(db, 'posts', 'first');
        const batch = writeBatch(db);
        batch.set(post, { author });
        await batch.commit();
        return post;
      `, transport.flags, transport.inPage);
    });

    test('batch update replaces a reference field without losing its value type', async ({ browser }) => {
      await followWrittenReference(browser, `
        const author = doc(db, 'authors', 'alice');
        await setDoc(author, { name: 'Alice' });
        const post = doc(db, 'posts', 'first');
        await setDoc(post, { author: doc(db, 'authors', 'missing') });
        const batch = writeBatch(db);
        batch.update(post, { author });
        await batch.commit();
        return post;
      `, transport.flags, transport.inPage);
    });

    test('transaction set copies a reference from a transaction snapshot', async ({ browser }) => {
      await followWrittenReference(browser, `
        const author = doc(db, 'authors', 'alice');
        await setDoc(author, { name: 'Alice' });
        const original = doc(db, 'posts', 'original');
        await setDoc(original, { author });
        const post = doc(db, 'posts', 'copy');
        await runTransaction(db, async (transaction) => {
          const snapshot = await transaction.get(original);
          transaction.set(post, { author: snapshot.data().author });
        });
        return post;
      `, transport.flags, transport.inPage);
    });

    test('transaction update stores a snapshot reference with its value type', async ({ browser }) => {
      await followWrittenReference(browser, `
        const author = doc(db, 'authors', 'alice');
        await setDoc(author, { name: 'Alice' });
        const post = doc(db, 'posts', 'first');
        await setDoc(post, { author: doc(db, 'authors', 'missing') });
        await runTransaction(db, async (transaction) => {
          const snapshot = await transaction.get(author);
          transaction.update(post, { author: snapshot.ref });
        });
        return post;
      `, transport.flags, transport.inPage);
    });
  });
}

async function followWrittenReference(browser: Browser, writeBody: string, flags: string[], inPage: boolean): Promise<void> {
  const serve = await startSoakServe({
    flags,
    extraFiles: {
      'firestore.rules': "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /authors/{id} { allow read: if true; allow write: if request.resource.data.name == 'Alice'; } match /posts/{id} { allow read: if true; allow write: if request.resource.data.author is reference; } } }",
      'index.html': '<button id="write">Save author reference</button><output id="result">Ready</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { addDoc, collection, doc, getDoc, getFirestore, runTransaction, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        const db = getFirestore(app);
        const result = document.querySelector('#result');
        async function write() {
          ${writeBody}
        }
        document.querySelector('#write').addEventListener('click', async () => {
          try {
            const post = await write();
            const saved = await getDoc(post);
            const authorSnapshot = await getDoc(saved.data().author);
            result.textContent = authorSnapshot.data().name;
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
          }
        });
      `,
    },
  });
  const context = await browser.newContext();
  try {
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
    await page.getByRole('button', { name: 'Save author reference', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('Alice');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
}
