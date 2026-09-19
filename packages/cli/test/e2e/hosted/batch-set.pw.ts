import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const replacementRules = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /profiles/{id} {
        allow read, create: if true;
        allow update: if request.resource.data.keys().hasOnly(['name', 'settings']);
      }
    }
  }
`;

const siblingRules = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /profiles/{id} { allow read, write: if true; }
      match /receipts/{id} {
        allow create: if getAfter(/databases/$(database)/documents/profiles/alice)
          .data.keys().hasOnly(['name', 'settings']);
      }
    }
  }
`;

for (const transport of [
  { name: 'hosted', flags: ['--hosted', '--no-capture'] },
  { name: 'SharedWorker', flags: ['--no-capture'] },
]) {
  for (const writer of [
    {
      name: 'batch',
      writeBody: `
        const batch = writeBatch(db);
        batch.set(profile, { name: 'Alicia', settings: { theme: 'light' } });
        await batch.commit();
      `,
      siblingWriteBody: `
        const batch = writeBatch(db);
        batch.set(profile, { name: 'Alicia', settings: { theme: 'light' } });
        batch.set(doc(db, 'receipts', 'replacement'), { saved: true });
        await batch.commit();
      `,
    },
    {
      name: 'transaction',
      writeBody: `
        await runTransaction(db, async (transaction) => {
          transaction.set(profile, { name: 'Alicia', settings: { theme: 'light' } });
        });
      `,
      siblingWriteBody: `
        await runTransaction(db, async (transaction) => {
          transaction.set(profile, { name: 'Alicia', settings: { theme: 'light' } });
          transaction.set(doc(db, 'receipts', 'replacement'), { saved: true });
        });
      `,
    },
  ]) {
    test(`${transport.name} ${writer.name} set replaces an existing document`, async ({ browser }) => {
      await replaceProfile(browser, transport.flags, undefined, writer.writeBody);
    });

    test(`${transport.name} ${writer.name} replacement rules see only the new document fields`, async ({ browser }) => {
      await replaceProfile(browser, transport.flags, replacementRules, writer.writeBody);
    });

    test(`${transport.name} ${writer.name} rules getAfter sees a replaced sibling document`, async ({ browser }) => {
      await replaceProfile(browser, transport.flags, siblingRules, writer.siblingWriteBody);
    });
  }
}

async function replaceProfile(
  browser: Browser,
  flags: string[],
  rules = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /profiles/{id} { allow read, write: if true; } } }",
  writeBody = `
    const batch = writeBatch(db);
    batch.set(profile, { name: 'Alicia', settings: { theme: 'light' } });
    await batch.commit();
  `,
): Promise<void> {
  const serve = await startSoakServe({
    flags,
    extraFiles: {
      'firestore.rules': rules,
      'index.html': '<button disabled id="save">Replace profile</button><output id="result">Starting</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { doc, getDoc, getFirestore, runTransaction, setDoc, writeBatch } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        const save = document.querySelector('#save');
        save.addEventListener('click', async () => {
          try {
            const profile = doc(db, 'profiles', 'alice');
            await setDoc(profile, { name: 'Alice', obsolete: true, settings: { theme: 'dark', alerts: true } });
            ${writeBody}
            result.textContent = JSON.stringify((await getDoc(profile)).data());
          } catch (error) {
            result.textContent = error.code + ': ' + error.message;
          }
        });
        save.disabled = false;
        result.textContent = 'Ready';
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
    await page.getByRole('button', { name: 'Replace profile', exact: true }).click();
    await expect(page.locator('#result')).toHaveText('{"name":"Alicia","settings":{"theme":"light"}}');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
}
