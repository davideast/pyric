/**
 * Named Firestore databases. `getFirestore(app, databaseId)` and
 * `getFirestore(databaseId)` return handles bound to that database, with
 * isolated documents and per-database rules evaluation.
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
  setRules(sandbox, OPEN_RULES, 'reports');
  setRules(sandbox, OPEN_RULES, 'archive');
  const app = createAppForSandbox(
    sandbox,
    { projectId: 'named-database-test' },
    `named-database-${Math.random().toString(36).slice(2)}`,
  );
  return { sandbox, app };
}

describe('getFirestore(app, databaseId) in the sandbox', () => {
  it('returns distinct cached handles per database id and aliases "" and "(default)"', () => {
    const { app } = sandboxApp();
    const defaultDb = getFirestore(app);
    expect(getFirestore(app, '(default)')).toBe(defaultDb);
    expect(getFirestore(app, '')).toBe(defaultDb);

    const reportsDb = getFirestore(app, 'reports');
    const archiveDb = getFirestore(app, 'archive');
    expect(reportsDb).not.toBe(defaultDb);
    expect(archiveDb).not.toBe(defaultDb);
    expect(archiveDb).not.toBe(reportsDb);
    expect(getFirestore(app, 'reports')).toBe(reportsDb);
    expect(reportsDb.app).toBe(app);
  });

  it('isolates documents between (default) and named databases', async () => {
    const { app } = sandboxApp();
    await setDoc(doc(getFirestore(app, 'reports'), 'items/one'), { from: 'reports' });
    await setDoc(doc(getFirestore(app, 'archive'), 'items/one'), { from: 'archive' });

    const fromDefault = await getDoc(doc(getFirestore(app), 'items/one'));
    const fromReports = await getDoc(doc(getFirestore(app, 'reports'), 'items/one'));
    const fromArchive = await getDoc(doc(getFirestore(app, 'archive'), 'items/one'));
    expect(fromDefault.exists()).toBe(false);
    expect(fromReports.data()).toEqual({ from: 'reports' });
    expect(fromArchive.data()).toEqual({ from: 'archive' });
  });

  it('rejects reads on an undeclared named database with unavailable (offline)', async () => {
    const { app } = sandboxApp();
    const missing = getFirestore(app, 'undeclared');
    await expect(getDoc(doc(missing, 'items/one'))).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('the rules `database` binding', () => {
  it('binds the database path variable to (default)', async () => {
    const { sandbox, app } = sandboxApp();
    setRules(
      sandbox,
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /probe/{id} {
      allow read, write: if database == '(default)';
    }
    match /named/{id} {
      allow read, write: if database == 'reports';
    }
  }
}`,
      'reports',
    );
    const reports = getFirestore(app, 'reports');
    await setDoc(doc(reports, 'probe/one'), { ok: true });
    expect((await getDoc(doc(reports, 'probe/one'))).data()).toEqual({ ok: true });
    await expect(setDoc(doc(reports, 'named/one'), { ok: true })).rejects.toThrow(/denied by rules/);
  });
});
