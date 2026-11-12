import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { collection, doc, getDoc, getDocs, getFirestore, setDoc } from 'pyric/firestore';
import { inspect, seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';

describe('Firestore sandbox setRules and seed modular 2+modules lowering', () => {
  test('lowers rules_version = 2+modules stdlib imports like Storage sandbox and fails closed on invalid imports', async () => {
    const sb = initializeSandbox();
    const st = getStorageSandbox(sb.withAuth({ uid: 'u1', token: {} }), {
      dbName: 'modular-parity-storage-db',
      rules: [
        "rules_version = '2+modules';",
        "import { isAuthenticated } from 'auth';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /items/{id} { allow write: if isAuthenticated(); }',
        '  }',
        '}',
      ].join('\n'),
    });
    await uploadBytes(storageRef(st, 'items/i1'), new Uint8Array([1]));

    const lint = setRules(
      sb,
      [
        "rules_version = '2+modules';",
        "import { isAuthenticated } from 'auth';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} { allow read, write: if isAuthenticated(); }',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(lint.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(inspect(sb).rules.lint.errors).toBe(0);

    const authedDb = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const anonDb = getFirestore(sb.withAuth(null));

    await setDoc(doc(authedDb, 'items', 'i1'), { ok: true });
    expect((await getDoc(doc(authedDb, 'items', 'i1'))).data()).toEqual({ ok: true });
    expect((await getDocs(collection(authedDb, 'items'))).size).toBe(1);
    await expect(getDoc(doc(anonDb, 'items', 'i1'))).rejects.toMatchObject({
      code: 'permission-denied',
    });

    // Preserves lowered modular rules across seedDocuments
    seedDocuments(sb, { 'items/i2': { ok: true } });
    expect((await getDoc(doc(authedDb, 'items', 'i2'))).data()).toEqual({ ok: true });
    await expect(getDoc(doc(anonDb, 'items', 'i2'))).rejects.toMatchObject({
      code: 'permission-denied',
    });

    // Invalid 2+modules import still fails closed
    setRules(
      sb,
      [
        "rules_version = '2+modules';",
        "import { doesNotExist } from 'auth';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} { allow read: if doesNotExist(); }',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(inspect(sb).rules.lint.errors).toBeGreaterThan(0);
    await expect(getDoc(doc(authedDb, 'items', 'i2'))).rejects.toThrow();
  });
});
