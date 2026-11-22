import { describe, expect, it } from 'bun:test';
import {
  collection,
  doc,
  getAdminFirestore,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  runTransaction,
  setDoc,
  terminate,
  writeBatch,
} from 'pyric/firestore';
import {
  DEFAULT_FIRESTORE_DATABASE,
  MAX_FIRESTORE_DATABASES,
  declareFirestoreDatabase,
  firestoreRecordSpaceKey,
  getDatabaseAdmin,
  isFirestoreDatabaseDeclared,
  isValidFirestoreDatabaseId,
  listDeclaredFirestoreDatabases,
  normalizeFirestoreDatabaseId,
  parseFirestoreRecordSpaceKey,
  undeclareFirestoreDatabase,
} from 'pyric/firestore/internal';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { inspect, seedDocuments, setRules, snapshotDocuments } from 'pyric/sandbox/firestore';

const OPEN_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if true; }',
  '  }',
  '}',
].join('\n');

const AUTH_ONLY_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if request.auth != null; }',
  '  }',
  '}',
].join('\n');

describe('Firestore named database identity and record-space encoding (ADR-0021)', () => {
  it('normalizes absent and empty selectors to (default) while preserving literal default', () => {
    expect(normalizeFirestoreDatabaseId()).toBe(DEFAULT_FIRESTORE_DATABASE);
    expect(normalizeFirestoreDatabaseId('')).toBe(DEFAULT_FIRESTORE_DATABASE);
    expect(normalizeFirestoreDatabaseId('(default)')).toBe(DEFAULT_FIRESTORE_DATABASE);
    expect(normalizeFirestoreDatabaseId('default')).toBe('default');
    expect(normalizeFirestoreDatabaseId('reports')).toBe('reports');
  });

  it('enforces Firebase database naming rules (4-63 chars, lowercase alnum/hyphen, non-UUID)', () => {
    expect(isValidFirestoreDatabaseId('(default)')).toBe(true);
    expect(isValidFirestoreDatabaseId('default')).toBe(true);
    expect(isValidFirestoreDatabaseId('reports')).toBe(true);
    expect(isValidFirestoreDatabaseId('abcd')).toBe(true);
    expect(isValidFirestoreDatabaseId(`a${'b'.repeat(61)}9`)).toBe(true);

    expect(isValidFirestoreDatabaseId('abc')).toBe(false);
    expect(isValidFirestoreDatabaseId(`a${'b'.repeat(62)}9`)).toBe(false);
    expect(isValidFirestoreDatabaseId('Bad_Id')).toBe(false);
    expect(isValidFirestoreDatabaseId('Reports')).toBe(false);
    expect(isValidFirestoreDatabaseId('1reports')).toBe(false);
    expect(isValidFirestoreDatabaseId('-reports')).toBe(false);
    expect(isValidFirestoreDatabaseId('reports-')).toBe(false);
    expect(isValidFirestoreDatabaseId('a/b/c')).toBe(false);
    expect(isValidFirestoreDatabaseId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('encodes injective record-space keys and refuses base keys containing /firestore/', () => {
    expect(firestoreRecordSpaceKey('hosted')).toBe('hosted');
    expect(firestoreRecordSpaceKey('hosted', '(default)')).toBe('hosted');
    expect(firestoreRecordSpaceKey('hosted', 'reports')).toBe('hosted/firestore/reports');
    expect(firestoreRecordSpaceKey('pyric-shared-worker:proj', 'analytics-1')).toBe(
      'pyric-shared-worker:proj/firestore/analytics-1',
    );

    expect(parseFirestoreRecordSpaceKey('hosted', 'hosted')).toBe('(default)');
    expect(parseFirestoreRecordSpaceKey('hosted', 'hosted/firestore/reports')).toBe('reports');
    expect(parseFirestoreRecordSpaceKey('hosted', 'hosted/firestore/(default)')).toBeNull();
    expect(parseFirestoreRecordSpaceKey('hosted', 'hosted/firestore/Bad_Id')).toBeNull();
    expect(parseFirestoreRecordSpaceKey('hosted', 'other')).toBeNull();

    expect(() => firestoreRecordSpaceKey('', 'reports')).toThrow(/base key/);
    expect(() => firestoreRecordSpaceKey('hosted/firestore/nested', 'reports')).toThrow(
      /\/firestore\//,
    );

    const bases = ['hosted', 'pyric-shared-worker', 'pyric-shared-worker:app-a', 'pyric-shared-worker:app-b'];
    const ids = ['(default)', 'default', 'reports', 'archive-2026'];
    const seen = new Set<string>();
    for (const base of bases) {
      for (const id of ids) {
        const key = firestoreRecordSpaceKey(base, id);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        expect(key.startsWith('rtdb:')).toBe(false);
      }
    }
  });

  it('enforces the 100-database quota per Sandbox including (default)', () => {
    const sandbox = initializeSandbox();
    for (let i = 1; i < MAX_FIRESTORE_DATABASES; i++) {
      const id = `db-${String(i).padStart(3, '0')}`;
      declareFirestoreDatabase(sandbox, id);
    }
    expect(listDeclaredFirestoreDatabases(sandbox).length).toBe(MAX_FIRESTORE_DATABASES - 1);
    // Re-declaring an existing database is idempotent.
    declareFirestoreDatabase(sandbox, 'db-001');
    expect(() => declareFirestoreDatabase(sandbox, 'db-overflow')).toThrow(/100/);
  });
});

describe('Per-database Sandbox LocalEnvironment isolation, C3 missing behavior, and reset', () => {
  it('isolates documents, rules, listeners, and transactions across databases', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    setRules(sandbox, AUTH_ONLY_RULES, 'reports');

    const defaultAnon = getFirestore(sandbox);
    const reportsAnon = getFirestore(sandbox, 'reports');
    const reportsAuthed = getFirestore(sandbox.withAuth({ uid: 'alice' }), 'reports');

    await setDoc(doc(defaultAnon, 'items/one'), { source: 'default' });
    await expect(setDoc(doc(reportsAnon, 'items/one'), { source: 'denied' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await setDoc(doc(reportsAuthed, 'items/one'), { source: 'reports' });

    expect((await getDoc(doc(defaultAnon, 'items/one'))).data()).toEqual({ source: 'default' });
    expect((await getDoc(doc(reportsAuthed, 'items/one'))).data()).toEqual({ source: 'reports' });
    expect(snapshotDocuments(sandbox)).toEqual({ 'items/one': { source: 'default' } });
    expect(snapshotDocuments(sandbox, 'reports')).toEqual({ 'items/one': { source: 'reports' } });

    const defaultSnapshots: Array<Record<string, unknown> | undefined> = [];
    const reportsSnapshots: Array<Record<string, unknown> | undefined> = [];
    const unsubDefault = onSnapshot(doc(defaultAnon, 'items/one'), (snap) => {
      defaultSnapshots.push((snap as { data(): Record<string, unknown> | undefined }).data());
    });
    const unsubReports = onSnapshot(doc(reportsAuthed, 'items/one'), (snap) => {
      reportsSnapshots.push((snap as { data(): Record<string, unknown> | undefined }).data());
    });

    await new Promise((r) => setTimeout(r, 10));
    const baseDefaultCount = defaultSnapshots.length;
    const baseReportsCount = reportsSnapshots.length;

    await setDoc(doc(reportsAuthed, 'items/one'), { source: 'reports-v2' });
    await new Promise((r) => setTimeout(r, 10));
    expect(defaultSnapshots.length).toBe(baseDefaultCount);
    expect(reportsSnapshots.length).toBeGreaterThan(baseReportsCount);
    expect(reportsSnapshots.at(-1)).toEqual({ source: 'reports-v2' });

    unsubDefault();
    unsubReports();

    // Cross-database references in writeBatch and runTransaction fail with invalid-argument.
    const batch = writeBatch(defaultAnon);
    expect(() => batch.set(doc(reportsAuthed, 'items/two'), { bad: true })).toThrow(
      /Provided document reference is from a different Firestore instance/,
    );
    await expect(
      runTransaction(defaultAnon, async (tx) => {
        await tx.get(doc(reportsAuthed, 'items/one'));
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('answers undeclared databases with C3 client offline/missing and Admin not-found behavior', async () => {
    const sandbox = initializeSandbox();
    const missingClient = getFirestore(sandbox, 'missing-db');

    await expect(getDoc(doc(missingClient, 'items/one'))).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Failed to get document because the client is offline.',
    });

    const firstSnap = await new Promise<{ fromCache: boolean; exists: boolean }>((resolve, reject) => {
      const unsub = onSnapshot(
        doc(missingClient, 'items/one'),
        (snap) => {
          const s = snap as { metadata: { fromCache: boolean }; exists(): boolean };
          unsub();
          resolve({ fromCache: s.metadata.fromCache, exists: s.exists() });
        },
        reject,
      );
    });
    expect(firstSnap).toEqual({ fromCache: true, exists: false });

    let settled = false;
    const pendingWrite = setDoc(doc(missingClient, 'items/pending'), { waiting: true }).then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await new Promise((r) => setTimeout(r, 25));
    expect(settled).toBe(false);
    await terminate(missingClient);
    void pendingWrite;

    expect(() => getDatabaseAdmin(sandbox, 'missing-db', 'proj-test')).toThrow(
      /The database missing-db does not exist for project proj-test/,
    );
    const missingAdmin = getAdminFirestore(sandbox, 'missing-db');
    await expect(getDoc(doc(missingAdmin, 'items/one'))).rejects.toThrow(
      /The database missing-db does not exist/,
    );
    expect(isFirestoreDatabaseDeclared(sandbox, 'missing-db')).toBe(false);
  });

  it('preserves declared databases and explicit rules across sandbox.reset() while clearing documents', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, AUTH_ONLY_RULES, 'reports');
    seedDocuments(sandbox, { 'items/one': { v: 1 } });
    seedDocuments(sandbox, { 'items/one': { v: 2 } }, 'reports');

    sandbox.reset();

    expect(isFirestoreDatabaseDeclared(sandbox, 'reports')).toBe(true);
    expect(snapshotDocuments(sandbox)).toEqual({});
    expect(snapshotDocuments(sandbox, 'reports')).toEqual({});

    // Explicit rules on `reports` remain enforced after reset().
    const reportsAnon = getFirestore(sandbox, 'reports');
    await expect(getDoc(doc(reportsAnon, 'items/one'))).rejects.toMatchObject({
      code: 'permission-denied',
    });

    undeclareFirestoreDatabase(sandbox, 'reports');
    expect(isFirestoreDatabaseDeclared(sandbox, 'reports')).toBe(false);
  });

  it('never leaks named-database documents into (default) on unwrapped memory persistence', async () => {
    const backend = createMemoryBackend();
    const first = initializeSandbox();
    await first.enablePersistence({ key: 'plain-key', injectedBackend: backend });
    setRules(first, OPEN_RULES);
    setRules(first, OPEN_RULES, 'reports');
    await setDoc(doc(getFirestore(first), 'items/default-doc'), { owner: 'default' });
    await setDoc(doc(getFirestore(first, 'reports'), 'items/reports-doc'), { owner: 'reports' });
    await first.flush();
    first.dispose();

    const second = initializeSandbox();
    await second.enablePersistence({ key: 'plain-key', injectedBackend: backend });
    const restoredDefault = snapshotDocuments(second);
    expect(restoredDefault).toEqual({ 'items/default-doc': { owner: 'default' } });
    expect(Object.hasOwn(restoredDefault, 'items/reports-doc')).toBe(false);
    second.dispose();
  });

  it('scopes inspect(sandbox, { databaseId }) events and denials per database', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, AUTH_ONLY_RULES);
    setRules(sandbox, OPEN_RULES, 'reports');

    await expect(getDoc(doc(getFirestore(sandbox), 'secret/default-only'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await setDoc(doc(getFirestore(sandbox, 'reports'), 'items/reports-only'), { ok: true });

    const defaultReport = inspect(sandbox);
    const reportsReport = inspect(sandbox, { databaseId: 'reports' });

    expect(defaultReport.events.recentDenials.map((d) => d.path)).toContain('secret/default-only');
    expect(defaultReport.events.recentRequests.some((r) => r.path === 'items/reports-only')).toBe(false);

    expect(reportsReport.events.recentDenials).toEqual([]);
    expect(reportsReport.events.recentRequests.map((r) => r.path)).toEqual(['items/reports-only']);
    expect(reportsReport.events.recentRequests.some((r) => r.path === 'secret/default-only')).toBe(false);
  });
});
