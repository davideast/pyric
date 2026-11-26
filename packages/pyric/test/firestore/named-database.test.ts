/**
 * Named Firestore databases. `getFirestore(app, databaseId)` and
 * `getFirestore(databaseId)` return handles bound to that database, with
 * isolated documents and per-database rules evaluation.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from 'pyric/app/internal';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  setDoc,
  where,
  writeBatch,
} from 'pyric/firestore';

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
  it('binds `database` and `request.path` to the active database id across reads and writes', async () => {
    const { sandbox, app } = sandboxApp();
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /probe/{id} {
      allow read, write: if database == '(default)'
        && request.path == /databases/(default)/documents/probe/$(id);
    }
    match /named/{id} {
      allow read, write: if database == 'reports'
        && request.path[1] == 'reports'
        && request.path == /databases/$(database)/documents/named/$(id);
    }
  }
}`;
    setRules(sandbox, rules);
    setRules(sandbox, rules, 'reports');

    const defaultDb = getFirestore(app);
    const reports = getFirestore(app, 'reports');

    await setDoc(doc(defaultDb, 'probe/one'), { ok: 'default' });
    expect((await getDoc(doc(defaultDb, 'probe/one'))).data()).toEqual({ ok: 'default' });
    await expect(setDoc(doc(defaultDb, 'named/one'), { ok: false })).rejects.toMatchObject({
      code: 'permission-denied',
    });

    await setDoc(doc(reports, 'named/one'), { ok: 'reports' });
    expect((await getDoc(doc(reports, 'named/one'))).data()).toEqual({ ok: 'reports' });
    await expect(setDoc(doc(reports, 'probe/one'), { ok: false })).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('matches literal database roots, supports multiple roots, and leaves `database` unbound under literal roots', async () => {
    const { sandbox, app } = sandboxApp();
    const multiRootRules = `rules_version = '2';
service cloud.firestore {
  match /databases/reports/documents {
    match /allowed/{id} {
      allow read, write: if true;
    }
    match /unbound/{id} {
      allow read, write: if database == 'reports';
    }
  }
  match /databases/(default)/documents {
    match /allowed/{id} {
      allow read, write: if false;
    }
  }
}`;
    setRules(sandbox, multiRootRules);
    setRules(sandbox, multiRootRules, 'reports');

    const defaultDb = getFirestore(app);
    const reports = getFirestore(app, 'reports');

    await setDoc(doc(reports, 'allowed/one'), { ok: true });
    expect((await getDoc(doc(reports, 'allowed/one'))).data()).toEqual({ ok: true });
    await expect(setDoc(doc(reports, 'unbound/one'), { ok: false })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(setDoc(doc(defaultDb, 'allowed/one'), { ok: false })).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('preserves active database inside helper functions and denies cross-database lookups while `|| true` grants', async () => {
    const { sandbox, app } = sandboxApp();
    seedDocuments(sandbox, { 'cfg/flag': { v: 'default' } });
    seedDocuments(sandbox, { 'cfg/flag': { v: 'reports' } }, 'reports');

    const rules = `rules_version = '2';
function readReportsFlag() {
  return get(/databases/reports/documents/cfg/flag).data.v == 'reports';
}
function readDefaultFlag() {
  return exists(/databases/(default)/documents/cfg/flag);
}
service cloud.firestore {
  match /databases/{database}/documents {
    match /helper-own/{id} {
      allow get: if readReportsFlag();
    }
    match /helper-cross/{id} {
      allow get: if readDefaultFlag();
    }
    match /cross-not-exists/{id} {
      allow get: if !exists(/databases/(default)/documents/cfg/flag);
    }
    match /cross-or-true/{id} {
      allow get: if get(/databases/(default)/documents/cfg/flag).data.v == 'nope' || true;
    }
    match /cross-after/{id} {
      allow create: if existsAfter(/databases/(default)/documents/cfg/flag);
    }
    match /cross-get-after/{id} {
      allow create: if getAfter(/databases/(default)/documents/cfg/flag).data.v == 'default';
    }
    match /own-after/{id} {
      allow create: if getAfter(/databases/$(database)/documents/own-after/$(id)).data.ok == true;
    }
  }
}`;
    setRules(sandbox, rules, 'reports');

    const reports = getFirestore(app, 'reports');
    await expect(getDoc(doc(reports, 'helper-own/d1'))).resolves.toBeDefined();
    await expect(getDoc(doc(reports, 'helper-cross/d1'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(getDoc(doc(reports, 'cross-not-exists/d1'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(getDoc(doc(reports, 'cross-or-true/d1'))).resolves.toBeDefined();
    await expect(setDoc(doc(reports, 'cross-after/d1'), { ok: true })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(setDoc(doc(reports, 'cross-get-after/d1'), { ok: true })).rejects.toMatchObject({
      code: 'permission-denied',
    });

    const batch = writeBatch(reports);
    batch.set(doc(reports, 'own-after/d1'), { ok: true });
    await batch.commit();
    await runTransaction(reports, async (tx) => {
      tx.set(doc(reports, 'own-after/d2'), { ok: true });
    });
  });

  it('binds `database` across list queries, listeners, collectionGroup queries, and dynamic budget projection', async () => {
    const { sandbox, app } = sandboxApp();
    seedDocuments(
      sandbox,
      {
        'items/a': { kind: 'ok', flag: false },
        'parents/p1/entries/e1': { kind: 'ok' },
      },
      'reports',
    );
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if database == 'reports';
      allow list: if (resource.data.flag == true && get(resource.data.ref).data.ok == true)
        || (database == 'reports' && resource.data.kind == 'ok');
    }
    match /{path=**}/entries/{id} {
      allow list: if database == 'reports' && resource.data.kind == 'ok';
    }
  }
}`;
    setRules(sandbox, rules);
    setRules(sandbox, rules, 'reports');

    const defaultDb = getFirestore(app);
    const reports = getFirestore(app, 'reports');

    const listed = await getDocs(query(collection(reports, 'items'), where('kind', '==', 'ok')));
    expect(listed.docs.map((d) => d.id)).toEqual(['a']);
    await expect(
      getDocs(query(collection(defaultDb, 'items'), where('kind', '==', 'ok'))),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    const groupSnap = await getDocs(
      query(collectionGroup(reports, 'entries'), where('kind', '==', 'ok')),
    );
    expect(groupSnap.docs.map((d) => d.id)).toEqual(['e1']);
    await expect(
      getDocs(query(collectionGroup(defaultDb, 'entries'), where('kind', '==', 'ok'))),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    const listenerData = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const unsub = onSnapshot(
        doc(reports, 'items/a'),
        (snap) => {
          unsub();
          resolve(snap.data());
        },
        reject,
      );
    });
    expect(listenerData).toEqual({ kind: 'ok', flag: false });
  });
});
