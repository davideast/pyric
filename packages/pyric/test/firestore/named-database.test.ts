/**
 * Named Firestore databases. Production `getFirestore(app, databaseId)`
 * returns a handle bound to that database, with its own documents and its
 * own rules evaluation context. The sandbox models one database per app,
 * `(default)`. These tests pin that behavior so a change to it is a
 * deliberate registry edit.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from 'pyric/app/internal';
import { setRules } from 'pyric/sandbox/firestore';
import { doc, getDoc, getFirestore, setDoc } from 'pyric/firestore';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

function sandboxApp() {
  const sandbox = initializeSandbox();
  setRules(sandbox, OPEN_RULES);
  const app = createAppForSandbox(
    sandbox,
    { projectId: 'named-database-test' },
    `named-database-${Math.random().toString(36).slice(2)}`,
  );
  return { sandbox, app };
}

/** The two-argument production signature, which the sandbox overloads do not declare. */
const getFirestoreWithDatabaseId = getFirestore as unknown as (
  app: unknown,
  databaseId: string,
) => ReturnType<typeof getFirestore>;

describe('getFirestore(app, databaseId) in the sandbox', () => {
  it('returns the (default) database handle for any database id', () => {
    const { app } = sandboxApp();
    const defaultDb = getFirestore(app);
    expect(getFirestoreWithDatabaseId(app, 'reports')).toBe(defaultDb);
    expect(getFirestoreWithDatabaseId(app, 'archive')).toBe(defaultDb);
  });

  it('shares documents between database ids', async () => {
    const { app } = sandboxApp();
    await setDoc(doc(getFirestoreWithDatabaseId(app, 'reports'), 'items/one'), { from: 'reports' });
    const fromDefault = await getDoc(doc(getFirestore(app), 'items/one'));
    const fromArchive = await getDoc(doc(getFirestoreWithDatabaseId(app, 'archive'), 'items/one'));
    expect(fromDefault.data()).toEqual({ from: 'reports' });
    expect(fromArchive.data()).toEqual({ from: 'reports' });
  });
});

describe('the rules `database` binding', () => {
  it('binds the database path variable to (default)', async () => {
    const { sandbox, app } = sandboxApp();
    setRules(sandbox, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /probe/{id} {
      allow read, write: if database == '(default)';
    }
    match /named/{id} {
      allow read, write: if database == 'reports';
    }
  }
}`);
    const reports = getFirestoreWithDatabaseId(app, 'reports');
    await setDoc(doc(reports, 'probe/one'), { ok: true });
    expect((await getDoc(doc(reports, 'probe/one'))).data()).toEqual({ ok: true });
    await expect(setDoc(doc(reports, 'named/one'), { ok: true })).rejects.toThrow(/denied by rules/);
  });
});
