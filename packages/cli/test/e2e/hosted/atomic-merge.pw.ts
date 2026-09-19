import { test, expect, type Browser } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

const transports = [
  { name: 'hosted', flags: ['--hosted', '--no-capture'] },
  { name: 'SharedWorker', flags: ['--no-capture'] },
];

for (const transport of transports) {
  test(`${transport.name} batch merge preserves fields in nested maps`, async ({ browser }) => {
    await mergeProfile(browser, {
      flags: transport.flags,
      writeBody: `
        const batch = writeBatch(db);
        batch.set(profile, { settings: { theme: 'light' } }, { merge: true });
        batch.set(doc(db, 'receipts', 'saved'), { saved: true });
        await batch.commit();
      `,
      rules: `rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            function expectedProfile(data) {
              return data.name == 'Alice' && data.settings.theme == 'light' && data.settings.alerts == true;
            }
            match /profiles/{id} {
              allow read, create: if true;
              allow update: if expectedProfile(request.resource.data);
            }
            match /receipts/{id} {
              allow create: if expectedProfile(getAfter(/databases/$(database)/documents/profiles/alice).data);
            }
          }
        }`,
      expected: '{"name":"Alice","settings":{"theme":"light","alerts":true}}',
    });
  });

  test(`${transport.name} batch mergeFields changes only the selected nested field`, async ({ browser }) => {
    await mergeProfile(browser, {
      flags: transport.flags,
      writeBody: `
        const batch = writeBatch(db);
        batch.set(profile, { name: 'Mallory', settings: { theme: 'light', alerts: false } }, { mergeFields: ['settings.alerts'] });
        batch.set(doc(db, 'receipts', 'saved'), { saved: true });
        await batch.commit();
      `,
      rules: `rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            function expectedProfile(data) {
              return data.name == 'Alice' && data.settings.theme == 'dark' && data.settings.alerts == false;
            }
            match /profiles/{id} {
              allow read, create: if true;
              allow update: if expectedProfile(request.resource.data);
            }
            match /receipts/{id} {
              allow create: if expectedProfile(getAfter(/databases/$(database)/documents/profiles/alice).data);
            }
          }
        }`,
      expected: '{"name":"Alice","settings":{"theme":"dark","alerts":false}}',
    });
  });

  test(`${transport.name} batch refuses a missing mask field without committing`, async ({ browser }) => {
    await mergeProfile(browser, {
      flags: transport.flags,
      writeBody: `
        const batch = writeBatch(db);
        let outcome = 'committed';
        try {
          batch.set(profile, { settings: { alerts: false } }, { mergeFields: ['settings.alerts', 'missing'] });
          await batch.commit();
        } catch (error) {
          outcome = error.code;
        }
        result.dataset.outcome = outcome;
      `,
      expected: '{"name":"Alice","settings":{"theme":"dark","alerts":true}}',
      outcome: 'invalid-argument',
    });
  });
  test(`${transport.name} transaction merge preserves fields in nested maps`, async ({ browser }) => {
    await mergeProfile(browser, {
      flags: transport.flags,
      writeBody: `
        await runTransaction(db, async (transaction) => {
          transaction.set(profile, { settings: { theme: 'light' } }, { merge: true });
        });
      `,
      expected: '{"name":"Alice","settings":{"theme":"light","alerts":true}}',
    });
  });

  test(`${transport.name} transaction composes two merges of the same document`, async ({ browser }) => {
    await mergeProfile(browser, {
      flags: transport.flags,
      writeBody: `
        await runTransaction(db, async (transaction) => {
          transaction.set(profile, { settings: { theme: 'light' } }, { merge: true });
          transaction.set(profile, { settings: { alerts: false } }, { merge: true });
        });
      `,
      expected: '{"name":"Alice","settings":{"theme":"light","alerts":false}}',
    });
  });

  test(`${transport.name} transaction mergeFields changes only the selected nested field`, async ({ browser }) => {
    await mergeProfile(browser, {
      flags: transport.flags,
      writeBody: `
        await runTransaction(db, async (transaction) => {
          transaction.set(profile, { name: 'Mallory', settings: { theme: 'light', alerts: false } }, { mergeFields: ['settings.alerts'] });
          transaction.set(doc(db, 'receipts', 'saved'), { saved: true });
        });
      `,
      rules: `rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            function expectedProfile(data) {
              return data.name == 'Alice' && data.settings.theme == 'dark' && data.settings.alerts == false;
            }
            match /profiles/{id} {
              allow read, create: if true;
              allow update: if expectedProfile(request.resource.data);
            }
            match /receipts/{id} {
              allow create: if expectedProfile(getAfter(/databases/$(database)/documents/profiles/alice).data);
            }
          }
        }`,
      expected: '{"name":"Alice","settings":{"theme":"dark","alerts":false}}',
    });
  });

  test(`${transport.name} transaction refuses a missing mask field without committing`, async ({ browser }) => {
    await mergeProfile(browser, {
      flags: transport.flags,
      writeBody: `
        let outcome = 'committed';
        try {
          await runTransaction(db, async (transaction) => {
            transaction.set(profile, { settings: { alerts: false } }, { mergeFields: ['settings.alerts', 'missing'] });
          });
        } catch (error) {
          outcome = error.code;
        }
        result.dataset.outcome = outcome;
      `,
      expected: '{"name":"Alice","settings":{"theme":"dark","alerts":true}}',
      outcome: 'invalid-argument',
    });
  });
}

for (const transport of transports) {
  for (const writer of ['batch', 'transaction'] as const) {
    test(`${transport.name} ${writer} composes two field masks without changing unselected fields`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        writeBody: commitWrites(writer, `
          writer.set(profile, { name: 'Mallory', settings: { theme: 'light', alerts: false } }, { mergeFields: ['settings.theme'] });
          writer.set(profile, { name: 'Eve', settings: { theme: 'ignored', alerts: false } }, { mergeFields: ['settings.alerts'] });
        `),
        expected: '{"name":"Alice","settings":{"theme":"light","alerts":false}}',
      });
    });

    test(`${transport.name} ${writer} rules evaluate the final document after two masks`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        writeBody: commitWrites(writer, `
          writer.set(profile, { settings: { theme: 'light' } }, { mergeFields: ['settings.theme'] });
          writer.set(profile, { settings: { alerts: false } }, { mergeFields: ['settings.alerts'] });
        `),
        rules: `rules_version = '2'; service cloud.firestore {
          match /databases/{database}/documents {
            match /profiles/{id} {
              allow read, create: if true;
              allow update: if resource.data.name == 'Alice' && resource.data.settings.theme == 'dark'
                && request.resource.data.name == 'Alice' && request.resource.data.settings.theme == 'light'
                && request.resource.data.settings.alerts == false;
            }
          }
        }`,
        expected: '{"name":"Alice","settings":{"theme":"light","alerts":false}}',
      });
    });

    test(`${transport.name} ${writer} applies repeated increments to the preceding write`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        writeBody: commitWrites(writer, `
          writer.set(profile, { count: 10 });
          writer.set(profile, { count: increment(2) }, { merge: true });
          writer.set(profile, { count: increment(3) }, { merge: true });
        `),
        expected: '{"count":15}',
      });
    });
    test(`${transport.name} ${writer} nested update replaces the map in request rules and getAfter`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        writeBody: commitWrites(writer, `
          writer.update(profile, { settings: { alerts: false } });
          writer.set(doc(db, 'receipts', 'saved'), { saved: true });
        `),
        rules: `rules_version = '2'; service cloud.firestore {
          match /databases/{database}/documents {
            function expectedProfile(data) {
              return data.name == 'Alice' && data.settings.keys().hasOnly(['alerts']) && data.settings.alerts == false;
            }
            match /profiles/{id} {
              allow read, create: if true;
              allow update: if expectedProfile(request.resource.data);
            }
            match /receipts/{id} {
              allow create: if expectedProfile(getAfter(/databases/$(database)/documents/profiles/alice).data);
            }
          }
        }`,
        expected: '{"name":"Alice","settings":{"alerts":false}}',
      });
    });

    test(`${transport.name} ${writer} dotted update preserves siblings in request rules and getAfter`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        writeBody: commitWrites(writer, `
          writer.update(profile, { 'settings.alerts': false });
          writer.set(doc(db, 'receipts', 'saved'), { saved: true });
        `),
        rules: `rules_version = '2'; service cloud.firestore {
          match /databases/{database}/documents {
            function expectedProfile(data) {
              return data.name == 'Alice' && data.settings.theme == 'dark' && data.settings.alerts == false;
            }
            match /profiles/{id} {
              allow read, create: if true;
              allow update: if expectedProfile(request.resource.data);
            }
            match /receipts/{id} {
              allow create: if expectedProfile(getAfter(/databases/$(database)/documents/profiles/alice).data);
            }
          }
        }`,
        expected: '{"name":"Alice","settings":{"theme":"dark","alerts":false}}',
      });
    });
  }
}

for (const transport of transports) {
  for (const writer of ['batch', 'transaction'] as const) {
    test(`${transport.name} ${writer} updates a document created earlier in the same commit`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        writeBody: `
          await deleteDoc(profile);
          ${commitWrites(writer, `
            writer.set(profile, { name: 'Alice', count: 1 });
            writer.update(profile, { count: 2 });
          `)}
        `,
        expected: '{"name":"Alice","count":2}',
      });
    });

    test(`${transport.name} ${writer} uses creation rules for create then update`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        writeBody: `
          await deleteDoc(profile);
          ${commitWrites(writer, `
            writer.set(profile, { name: 'Alice', count: 1 });
            writer.update(profile, { count: 2 });
          `)}
        `,
        rules: `rules_version = '2'; service cloud.firestore {
          match /databases/{database}/documents {
            match /profiles/{id} { allow read, create, delete: if true; }
          }
        }`,
        expected: '{"name":"Alice","count":2}',
      });
    });

    test(`${transport.name} ${writer} refuses delete then update without changing data`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        writeBody: `
          try {
            ${commitWrites(writer, `
              writer.delete(profile);
              writer.update(profile, { name: 'Mallory' });
            `)}
            result.dataset.outcome = 'committed';
          } catch (error) {
            result.dataset.outcome = error.code;
          }
        `,
        expected: '{"name":"Alice","settings":{"theme":"dark","alerts":true}}',
        outcome: 'invalid-argument',
      });
    });

    test(`${transport.name} ${writer} replaces a document after deleting it`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        writeBody: commitWrites(writer, `
          writer.delete(profile);
          writer.set(profile, { count: 3 });
        `),
        expected: '{"count":3}',
      });
    });

    test(`${transport.name} ${writer} updates a document recreated after deletion`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        writeBody: commitWrites(writer, `
          writer.delete(profile);
          writer.set(profile, { count: 5 });
          writer.update(profile, { count: 6 });
        `),
        expected: '{"count":6}',
      });
    });

    test(`${transport.name} ${writer} deletes the same document twice`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        writeBody: commitWrites(writer, `
          writer.delete(profile);
          writer.delete(profile);
        `),
        expected: 'null',
      });
    });
  }
}

const valueCaptureTransports = [
  ...transports.map((transport) => ({ ...transport, inPage: false })),
  { name: 'in-page', flags: ['--no-capture'], inPage: true },
];

for (const transport of valueCaptureTransports) {
  for (const [writer, behaviour] of [
    ['batch', 'captures the field mask when the write is queued'],
    ['transaction', 'retains the field mask supplied to set'],
  ] as const) {
    test(`${transport.name} ${writer} ${behaviour}`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        inPage: transport.inPage,
        writeBody: commitWrites(writer, `
          const mergeFields = ['settings.theme'];
          writer.set(profile, { name: 'Mallory', settings: { theme: 'light' } }, { mergeFields });
          mergeFields[0] = 'name';
        `),
        expected: '{"name":"Alice","settings":{"theme":"light","alerts":true}}',
      });
    });
  }
}

for (const transport of valueCaptureTransports) {
  for (const writer of ['batch', 'transaction'] as const) {
    test(`${transport.name} ${writer} captures nested document values when queued`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        inPage: transport.inPage,
        writeBody: commitWrites(writer, `
          const data = { name: 'Bob', settings: { theme: 'light', alerts: false } };
          writer.set(profile, data);
          data.name = 'Mallory';
          data.settings.theme = 'dark';
        `),
        expected: '{"name":"Bob","settings":{"theme":"light","alerts":false}}',
      });
    });
  }
}

for (const transport of valueCaptureTransports) {
  for (const writer of ['batch', 'transaction'] as const) {
    test(`${transport.name} ${writer} captures nested update values when queued`, async ({ browser }) => {
      await mergeProfile(browser, {
        flags: transport.flags,
        inPage: transport.inPage,
        writeBody: commitWrites(writer, `
          const update = { settings: { theme: 'light', alerts: false } };
          writer.update(profile, update);
          update.settings.theme = 'dark';
        `),
        expected: '{"name":"Alice","settings":{"theme":"light","alerts":false}}',
      });
    });
  }
}

function commitWrites(writer: 'batch' | 'transaction', body: string): string {
  const isBatch = writer === 'batch';
  if (isBatch) return `const writer = writeBatch(db); ${body} await writer.commit();`;
  return `await runTransaction(db, async (writer) => { ${body} });`;
}

async function mergeProfile(browser: Browser, scenario: {
  flags: string[];
  inPage?: boolean;
  rules?: string;
  writeBody: string;
  expected: string;
  outcome?: string;
}): Promise<void> {
  const serve = await startSoakServe({
    flags: scenario.flags,
    extraFiles: {
      'firestore.rules': scenario.rules ?? "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /profiles/{id} { allow read, write: if true; } } }",
      'index.html': '<button disabled id="save">Merge profile</button><output id="result">Starting</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { deleteDoc, doc, getDoc, getFirestore, increment, runTransaction, setDoc, writeBatch } from 'firebase/firestore';
        const db = getFirestore(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        const result = document.querySelector('#result');
        const save = document.querySelector('#save');
        save.addEventListener('click', async () => {
          try {
            const profile = doc(db, 'profiles', 'alice');
            await setDoc(profile, { name: 'Alice', settings: { theme: 'dark', alerts: true } });
            ${scenario.writeBody}
            result.textContent = JSON.stringify((await getDoc(profile)).data() ?? null);
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
    const usesInPage = scenario.inPage === true;
    if (usesInPage) {
      await context.addInitScript(() => {
        Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true });
      });
    }
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(serve.info.url);
    await expect(page.locator('#result')).toHaveText('Ready');
    await page.getByRole('button', { name: 'Merge profile', exact: true }).click();
    await expect(page.locator('#result')).toHaveText(scenario.expected);
    const { outcome } = scenario;
    const hasOutcome = outcome !== undefined;
    if (hasOutcome) await expect(page.locator('#result')).toHaveAttribute('data-outcome', outcome);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await serve.stop();
  }
}
