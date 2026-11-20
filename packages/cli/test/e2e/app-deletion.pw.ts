import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const observation = JSON.parse(readFileSync(resolve(
  import.meta.dirname,
  '../../../conformance/observations/app/app-registry-deleted-service-factories.json',
), 'utf8')).behavior as Record<string, Record<string, unknown>>;

test('served firebase imports replay the production app-deletion lifecycle', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'loading');

  const actual = await page.evaluate(async () => {
    const appModule = await import('firebase/app');
    const aiModule = await import('firebase/ai');
    const appCheckModule = await import('firebase/app-check');
    const authModule = await import('firebase/auth');
    const databaseModule = await import('firebase/database');
    const firestoreModule = await import('firebase/firestore');
    const storageModule = await import('firebase/storage');

    const capture = (run: () => unknown, expectedApp: unknown): Record<string, unknown> => {
      try {
        const value = run() as { app?: unknown };
        return { threw: false, usesDeletedApp: value?.app === expectedApp };
      } catch (error) {
        const candidate = error as Error & { code?: string };
        return {
          threw: true,
          errorName: candidate.constructor.name,
          isError: candidate instanceof Error,
          code: candidate.code ?? null,
          message: candidate.message,
        };
      }
    };
    const captureAsync = async (run: () => Promise<unknown>): Promise<Record<string, unknown>> => {
      try {
        await run();
        return { threw: false };
      } catch (error) {
        const candidate = error as Error & { code?: string };
        return {
          threw: true,
          errorName: candidate.constructor.name,
          isError: candidate instanceof Error,
          code: candidate.code ?? null,
          message: candidate.message,
        };
      }
    };

    const options = { ...appModule.getApp().options };
    const retainedApp = appModule.initializeApp(options, 'retained-services');
    const auth = authModule.getAuth(retainedApp);
    const firestore = firestoreModule.getFirestore(retainedApp);
    const firestoreDoc = firestoreModule.doc(firestore, 'notes/note-01');
    const database = databaseModule.getDatabase(retainedApp);
    const storage = storageModule.getStorage(retainedApp);
    const customEngineApp = appModule.initializeApp(options, 'custom-ai-engine');
    const customEngineFactory = capture(() => aiModule.getAI(customEngineApp, {
      engine: {
        async generateContent() {
          return { candidates: [] };
        },
        streamGenerateContent() {
          return (async function* empty() {})();
        },
        async countTokens() {
          return { totalTokens: 7 };
        },
      },
    }), customEngineApp);
    appCheckModule.initializeAppCheck(retainedApp, {
      provider: new appCheckModule.ReCaptchaV3Provider('site-key'),
    });
    const retainedAi = aiModule.getAI(retainedApp, {
      engine: { kind: 'scripted' },
    });
    const retainedAiModel = aiModule.getGenerativeModel(
      retainedAi,
      { model: 'gemini-2.5-flash' },
    );
    const survivingApp = appModule.initializeApp(options, 'surviving-ai');
    // The sandbox refuses AI Logic requests without an App Check token, so App
    // Check comes before getAI.
    appCheckModule.initializeAppCheck(survivingApp, {
      provider: new appCheckModule.ReCaptchaV3Provider('site-key'),
    });
    const survivingAiModel = aiModule.getGenerativeModel(
      aiModule.getAI(survivingApp),
      { model: 'gemini-2.5-flash' },
    );
    await appModule.deleteApp(retainedApp);

    const deletedApp = appModule.initializeApp(options, 'deleted-services');
    await appModule.deleteApp(deletedApp);

    const deletedAi = aiModule.getAI(deletedApp);
    const deletedAiModelFactory = capture(
      () => aiModule.getGenerativeModel(deletedAi, { model: 'gemini-2.5-flash' }),
      deletedApp,
    );
    const retainedAiModelFactory = capture(
      () => aiModule.getGenerativeModel(retainedAi, { model: 'gemini-2.5-flash' }),
      retainedApp,
    );

    const retainedAiOperation = await captureAsync(() => retainedAiModel.countTokens('still live after delete'));
    const survivingAiOperation = await captureAsync(() => survivingAiModel.countTokens('still live'));

    return { observed: {
      auth: capture(() => authModule.getAuth(deletedApp), deletedApp),
      firestore: capture(() => firestoreModule.getFirestore(deletedApp), deletedApp),
      database: capture(() => databaseModule.getDatabase(deletedApp), deletedApp),
      storage: capture(() => storageModule.getStorage(deletedApp), deletedApp),
      ai: capture(() => deletedAi, deletedApp),
      cachedAuthFactory: capture(() => authModule.getAuth(retainedApp), retainedApp),
      cachedFirestoreFactory: capture(() => firestoreModule.getFirestore(retainedApp), retainedApp),
      cachedDatabaseFactory: capture(() => databaseModule.getDatabase(retainedApp), retainedApp),
      cachedStorageFactory: capture(() => storageModule.getStorage(retainedApp), retainedApp),
      retainedAuthSignOut: await captureAsync(() => authModule.signOut(auth)),
      retainedFirestoreGet: await captureAsync(() => firestoreModule.getDoc(firestoreDoc)),
      retainedDatabaseRef: capture(() => databaseModule.ref(database, 'notes/note-01'), deletedApp),
      retainedStorageRef: capture(
        () => storageModule.ref(storage, 'notes/note-01').toString(),
        deletedApp,
      ),
    }, customEngineFactory, deletedAiModelFactory, retainedAiModelFactory, retainedAiOperation,
      survivingAiOperation };
  });

  expect(actual.observed).toEqual(observation);
  expect(actual.customEngineFactory).toMatchObject({ threw: true, code: 'unsupported' });
  expect(actual.deletedAiModelFactory).toMatchObject({ threw: true, code: 'app/app-deleted' });
  expect(actual.retainedAiModelFactory).toMatchObject({ threw: true, code: 'app/app-deleted' });
  expect(actual.retainedAiOperation).toMatchObject({ threw: false });
  expect(actual.survivingAiOperation).toMatchObject({ threw: false });
});
