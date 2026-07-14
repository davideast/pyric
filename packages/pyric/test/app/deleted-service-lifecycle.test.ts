import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteApp, initializeApp } from 'pyric/app';
import { registerAppCleanup } from 'pyric/app/internal';
import { getAI, getGenerativeModel } from 'pyric/ai';
import {
  beforeAuthStateChanged,
  getAuth,
  signInAnonymously,
  signOut,
} from 'pyric/auth';
import { getDatabase, ref as databaseRef } from 'pyric/database';
import { doc, getDoc, getFirestore } from 'pyric/firestore';
import { getStorage, ref as storageRef } from 'pyric/storage';
import { resetAppRegistryForTests } from '../../dist/app/registry.js';

const observation = JSON.parse(readFileSync(join(
  import.meta.dir,
  '..', '..', '..', '..',
  'packages', 'conformance', 'observations', 'app',
  'app-registry-deleted-service-factories.json',
), 'utf8')).behavior as Record<string, Record<string, unknown>>;

beforeEach(() => resetAppRegistryForTests());

it('retained services follow Firebase deletion lifecycle', async () => {
  const app = initializeApp({ projectId: 'deleted-service-lifecycle' }, 'retained-services');
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  const firestoreDoc = doc(firestore, 'notes/note-01');
  const database = getDatabase(app);
  const storage = getStorage(app);
  let aiCalls = 0;
  const ai = getAI(app, {
    engine: {
      async generateContent() {
        aiCalls += 1;
        return { candidates: [] };
      },
      streamGenerateContent() {
        aiCalls += 1;
        return (async function* empty() {})();
      },
      async countTokens() {
        aiCalls += 1;
        return { totalTokens: 7 };
      },
    },
  });
  const aiModel = getGenerativeModel(ai, { model: 'gemini-2.5-flash' });

  await deleteApp(app);

  expect(getAuth(app)).toBe(auth);
  expect(getFirestore(app)).toBe(firestore);
  expect(getDatabase(app)).toBe(database);
  expect(getStorage(app)).toBe(storage);
  await expect(signOut(auth)).resolves.toBeUndefined();
  await expect(signInAnonymously(auth)).rejects.toMatchObject({
    code: 'app/app-deleted',
  });
  await expect(getDoc(firestoreDoc)).rejects.toMatchObject({
    code: observation.retainedFirestoreGet.code,
    message: observation.retainedFirestoreGet.message,
  });
  expect(() => databaseRef(database, 'notes/note-01')).toThrow(
    observation.retainedDatabaseRef.message as string,
  );
  expect(storageRef(storage, 'notes/note-01').toString()).toContain('notes/note-01');
  await expect(aiModel.countTokens('must stop')).rejects.toMatchObject({
    code: 'app/app-deleted',
  });
  expect(aiCalls).toBe(0);
});

it('deleting the default app removes its Auth transition middleware', async () => {
  const app = initializeApp({ projectId: 'default-auth-middleware-cleanup' });
  const auth = getAuth(app);
  await signInAnonymously(auth);
  beforeAuthStateChanged(auth, async () => {
    throw new Error('deleted default app middleware must not run');
  });

  await deleteApp(app);

  await expect(signOut(auth)).resolves.toBeUndefined();
});

it('deleteApp resolves only after app-owned asynchronous cleanup', async () => {
  const app = initializeApp({ projectId: 'awaited-app-cleanup' }, 'awaited-cleanup');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let resolved = false;
  registerAppCleanup(app, () => gate);

  const deleting = deleteApp(app).then(() => { resolved = true; });
  await Promise.resolve();
  expect(resolved).toBe(false);

  release();
  await deleting;
  expect(resolved).toBe(true);
});

it('deleteApp rejects after every app-owned cleanup has been attempted', async () => {
  const app = initializeApp({ projectId: 'failed-app-cleanup' }, 'failed-cleanup');
  let laterCleanupRan = false;
  registerAppCleanup(app, async () => {
    throw new Error('teardown failed');
  });
  registerAppCleanup(app, async () => {
    await Promise.resolve();
    laterCleanupRan = true;
  });

  await expect(deleteApp(app)).rejects.toThrow('teardown failed');
  expect(laterCleanupRan).toBe(true);
});
