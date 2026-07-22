import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  authStorageSignalMatches,
  observeCrossTabAuthAfterPersistenceSignal,
  type AuthStorageSignal,
} from '../../../conformance/src/cross-tab-auth-observer.js';

const crossTabObservation = JSON.parse(readFileSync(resolve(
  import.meta.dirname,
  '../../../conformance/observations/app/app-production-cross-tab-auth-persistence.json',
), 'utf8')).behavior as Record<string, boolean>;

test('same-named app instances replay production cross-tab Auth isolation', async ({ context }) => {
  const source = await context.newPage();
  const sibling = await context.newPage();
  await Promise.all([source.goto('/'), sibling.goto('/')]);
  await Promise.all([source, sibling].map((page) => page.waitForFunction(
    () => document.querySelector('#status')?.textContent !== 'loading',
  )));

  await sibling.evaluate(() => {
    const state = globalThis as unknown as {
      __pyricAuthEvents: Array<string | null>;
      __pyricAuthPersistenceSignals: AuthStorageSignal[];
    };
    state.__pyricAuthEvents = [];
    state.__pyricAuthPersistenceSignals = [];
    globalThis.addEventListener('storage', (event) => {
      if (event.storageArea === localStorage && event.key?.startsWith('pyric:serve:auth-session')) {
        state.__pyricAuthPersistenceSignals.push({ key: event.key, newValue: event.newValue });
      }
    });
  });
  await sibling.evaluate(async () => {
    const { getApp } = await import('firebase/app');
    const { getAuth, onAuthStateChanged } = await import('firebase/auth');
    const state = globalThis as unknown as { __pyricAuthEvents: Array<string | null> };
    await new Promise<void>((resolveInitial) => {
      onAuthStateChanged(getAuth(getApp()), (user) => {
        state.__pyricAuthEvents.push(user?.uid ?? null);
        if (state.__pyricAuthEvents.length === 1) resolveInitial();
      });
    });
  });

  const sourceUid = await source.evaluate(async () => {
    const { getApp } = await import('firebase/app');
    const { getAuth, signInAnonymously } = await import('firebase/auth');
    return (await signInAnonymously(getAuth(getApp()))).user.uid;
  });
  const siblingState = await observeCrossTabAuthAfterPersistenceSignal({
    sourceUid,
    waitForPersistenceSignal: async () => {
      await sibling.waitForFunction(({ expectedKey, expectedUid }) => {
        const signals = (globalThis as unknown as {
          __pyricAuthPersistenceSignals?: AuthStorageSignal[];
        }).__pyricAuthPersistenceSignals ?? [];
        return signals.some((signal) => {
          if (signal.key !== expectedKey || signal.newValue === null) return false;
          try {
            return (JSON.parse(signal.newValue) as { uid?: unknown }).uid === expectedUid;
          } catch {
            return false;
          }
        });
      }, { expectedKey: 'pyric:serve:auth-session', expectedUid: sourceUid });
      const signals = await sibling.evaluate(() => (
        (globalThis as unknown as { __pyricAuthPersistenceSignals: AuthStorageSignal[] })
          .__pyricAuthPersistenceSignals
      ));
      expect(signals.some((signal) => authStorageSignalMatches(
        signal,
        'pyric:serve:auth-session',
        sourceUid,
      ))).toBe(true);
    },
    readState: () => sibling.evaluate(async () => {
      const { getApp } = await import('firebase/app');
      const { getAuth } = await import('firebase/auth');
      const auth = getAuth(getApp());
      const state = globalThis as unknown as { __pyricAuthEvents: Array<string | null> };
      return {
        currentUid: auth.currentUser?.uid ?? null,
        events: [...state.__pyricAuthEvents],
      };
    }),
  });
  await source.evaluate(async () => {
    const { getApp } = await import('firebase/app');
    const { getAuth, signOut } = await import('firebase/auth');
    await signOut(getAuth(getApp()));
  });

  expect({
    localSignInPropagatesToSameNamedAppInSiblingTab:
      siblingState.currentUid === sourceUid && siblingState.events.includes(sourceUid),
    propagatedUidMatchesSource: siblingState.currentUid === sourceUid,
  }).toEqual(crossTabObservation);
});

test('same-origin tabs cannot silently attach conflicting Firebase configs to one backend', async ({
  context,
}) => {
  const first = await context.newPage();
  await first.goto('/');
  await first.waitForFunction(() => document.querySelector('#status')?.textContent !== 'loading');

  const second = await context.newPage();
  await second.route('**/main.js', async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "{ apiKey: 'demo', projectId: 'demo' }",
      "{ apiKey: 'conflict', projectId: 'conflict' }",
    );
    await route.fulfill({ response, body });
  });
  await second.goto('/');

  const error = await second.evaluate(async () => {
    const { getApp } = await import('firebase/app');
    const { doc, getDoc, getFirestore } = await import('firebase/firestore');
    try {
      await getDoc(doc(getFirestore(getApp()), 'config-lock/probe'));
      return null;
    } catch (caught) {
      const value = caught as { code?: string; message?: string };
      return { code: value.code, message: value.message };
    }
  });

  expect(error).toMatchObject({ code: 'app/multiple-configs-not-supported' });
});

test('served canonical imports keep equal-config apps isolated over one SharedWorker backend', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'loading');

  const actual = await page.evaluate(async () => {
    const appModule = await import('firebase/app');
    const authModule = await import('firebase/auth');
    const databaseModule = await import('firebase/database');
    const firestoreModule = await import('firebase/firestore');
    const storageModule = await import('firebase/storage');

    const primary = appModule.getApp();
    const sibling = appModule.initializeApp({ ...primary.options }, 'browser-sibling');
    const primaryAuth = authModule.getAuth(primary);
    const siblingAuth = authModule.getAuth(sibling);
    const primaryFirestore = firestoreModule.getFirestore(primary);
    const siblingFirestore = firestoreModule.getFirestore(sibling);
    const primaryDatabase = databaseModule.getDatabase(primary);
    const siblingDatabase = databaseModule.getDatabase(sibling);
    const primaryStorage = storageModule.getStorage(primary);
    const siblingStorage = storageModule.getStorage(sibling);

    await authModule.signInAnonymously(primaryAuth);
    const authIsolated = primaryAuth.currentUser !== null && siblingAuth.currentUser === null;
    // The deletion-listener oracle keeps both app sessions authorized before
    // deleting one; otherwise this fixture's rules reject the sibling listen
    // before deletion and the observed error is unrelated permission-denied.
    await authModule.signInAnonymously(siblingAuth);
    await firestoreModule.setDoc(
      firestoreModule.doc(primaryFirestore, 'multi-app/firestore'),
      { owner: 'primary' },
    );
    await databaseModule.set(databaseModule.ref(primaryDatabase, 'multi-app/database'), 'primary');
    await storageModule.uploadBytes(
      storageModule.ref(primaryStorage, 'multi-app/storage.bin'),
      new Uint8Array([1, 2, 3]),
    );

    const siblingDeliveries: unknown[] = [];
    const siblingErrors: Array<{ code?: string }> = [];
    const unsubscribe = firestoreModule.onSnapshot(
      firestoreModule.doc(siblingFirestore, 'multi-app/firestore'),
      (snapshot) => siblingDeliveries.push(snapshot.data()),
      (error) => siblingErrors.push(error),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const deliveriesBeforeDelete = siblingDeliveries.length;
    await appModule.deleteApp(sibling);
    await firestoreModule.setDoc(
      firestoreModule.doc(primaryFirestore, 'multi-app/firestore'),
      { owner: 'after-delete' },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    unsubscribe();

    return {
      distinctApps: primary !== sibling,
      distinctServices:
        primaryAuth !== siblingAuth
        && primaryFirestore !== siblingFirestore
        && primaryDatabase !== siblingDatabase
        && primaryStorage !== siblingStorage,
      authIsolated,
      firestoreShared: (await firestoreModule.getDoc(
        firestoreModule.doc(primaryFirestore, 'multi-app/firestore'),
      )).data()?.owner === 'after-delete',
      databaseShared: (await databaseModule.get(
        databaseModule.ref(primaryDatabase, 'multi-app/database'),
      )).val() === 'primary',
      storageShared: Array.from(new Uint8Array(await storageModule.getBytes(
        storageModule.ref(primaryStorage, 'multi-app/storage.bin'),
      ))),
      deletedSiblingListenerStopped: siblingDeliveries.length === deliveriesBeforeDelete,
      deletedSiblingListenerError: siblingErrors[0]?.code ?? null,
    };
  });

  expect(actual).toEqual({
    distinctApps: true,
    distinctServices: true,
    authIsolated: true,
    firestoreShared: true,
    databaseShared: true,
    storageShared: [1, 2, 3],
    deletedSiblingListenerStopped: true,
    deletedSiblingListenerError: 'aborted',
  });
});

test('unchanged firebase/database imports preserve the graduated worker behaviors', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'loading');

  const actual = await page.evaluate(async () => {
    const appModule = await import('firebase/app');
    const authModule = await import('firebase/auth');
    const databaseModule = await import('firebase/database');
    const app = appModule.initializeApp({ ...appModule.getApp().options }, 'rtdb-public-smoke');
    await authModule.signInAnonymously(authModule.getAuth(app));
    const database = databaseModule.getDatabase(app);
    const rows = databaseModule.ref(database, 'public-rtdb/rows');
    await databaseModule.setWithPriority(databaseModule.child(rows, 'a'), { rank: 1 }, 10);
    await databaseModule.setWithPriority(databaseModule.child(rows, 'b'), { rank: 2 }, 20);

    const onlyOnce: string[] = [];
    databaseModule.onChildAdded(rows, (snapshot) => onlyOnce.push(snapshot.key!), { onlyOnce: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await databaseModule.set(databaseModule.child(rows, 'c'), { rank: 3 });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const counter = databaseModule.ref(database, 'public-rtdb/counter');
    await databaseModule.set(counter, 1);
    await databaseModule.set(counter, databaseModule.increment(2));

    const offTarget = databaseModule.ref(database, 'public-rtdb/off');
    const calls: string[] = [];
    const kept = () => calls.push('kept');
    const removed = () => calls.push('removed');
    databaseModule.onValue(offTarget, kept);
    databaseModule.onValue(offTarget, removed);
    await new Promise((resolve) => setTimeout(resolve, 25));
    calls.length = 0;
    databaseModule.off(offTarget, 'value', removed);
    await databaseModule.set(offTarget, true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    databaseModule.off(offTarget);

    let invalidPathThrew = false;
    try {
      databaseModule.child(rows, 'invalid#path');
    } catch {
      invalidPathThrew = true;
    }
    const snapshot = await databaseModule.get(rows);
    const incrementValue = (await databaseModule.get(counter)).val();
    await appModule.deleteApp(app);
    return {
      increment: incrementValue,
      onlyOnce,
      offCalls: calls,
      invalidPathThrew,
      exportValue: snapshot.exportVal(),
      toJSON: snapshot.toJSON(),
    };
  });

  expect(actual).toEqual({
    increment: 3,
    onlyOnce: ['b', 'a'],
    offCalls: ['kept'],
    invalidPathThrew: true,
    exportValue: {
      a: { rank: 1, '.priority': 10 },
      b: { rank: 2, '.priority': 20 },
      c: { rank: 3 },
    },
    toJSON: {
      a: { rank: 1, '.priority': 10 },
      b: { rank: 2, '.priority': 20 },
      c: { rank: 3 },
    },
  });
});
