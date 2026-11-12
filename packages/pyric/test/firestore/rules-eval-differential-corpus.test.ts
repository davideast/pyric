import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { firestoreRules, reference } from 'pyric/rules';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getDoc, getFirestore, runTransaction, setDoc, writeBatch } from 'pyric/firestore';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';

describe('Firestore rules evaluation differential corpus', () => {
  test('Reference and Path values agree across all rules.Path operations in simulate() and Sandbox', async () => {
    const expressions = [
      'val is path',
      'val == /databases/(default)/documents/orgs/org-1',
      '/databases/(default)/documents/orgs/org-1 == val',
      'val != /databases/analytics/documents/orgs/org-1',
      "val[0] == 'databases' && val[1] == '(default)' && val[2] == 'documents' && val[3] == 'orgs' && val[4] == 'org-1'",
      "string(val) == '/databases/(default)/documents/orgs/org-1'",
      '/$(val) == /databases/(default)/documents/orgs/org-1',
      'val.bind({}) == /databases/(default)/documents/orgs/org-1',
      "exists(val) && get(val).data.ownerId == 'u1'",
    ];

    const sb = initializeSandbox();
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    seedDocuments(sb, {
      'orgs/org-1': { ownerId: 'u1' },
      'items/ref-item': { target: doc(db, 'orgs', 'org-1') },
    });

    for (const expr of expressions) {
      const refRulesSource = [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    function check(val) {',
        `      return ${expr};`,
        '    }',
        '    match /items/{id} {',
        '      allow get: if check(resource.data.target);',
        '    }',
        '  }',
        '}',
      ].join('\n');

      const pathRulesSource = [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    function check(val) {',
        `      return ${expr};`,
        '    }',
        '    match /items/{id} {',
        '      allow get: if check(/databases/(default)/documents/orgs/org-1);',
        '    }',
        '  }',
        '}',
      ].join('\n');

      const simRef = firestoreRules(refRulesSource).simulate([
        {
          description: `Reference: ${expr}`,
          expectation: 'ALLOW',
          method: 'get',
          path: 'items/ref-item',
          auth: { uid: 'u1' },
          resource: { target: reference('orgs/org-1') },
          functionMocks: [
            { function: 'exists', path: 'orgs/org-1', result: true },
            { function: 'get', path: 'orgs/org-1', result: { ownerId: 'u1' } },
          ],
        },
      ]);
      const simPath = firestoreRules(pathRulesSource).simulate([
        {
          description: `Path: ${expr}`,
          expectation: 'ALLOW',
          method: 'get',
          path: 'items/ref-item',
          auth: { uid: 'u1' },
          resource: {},
          functionMocks: [
            { function: 'exists', path: 'orgs/org-1', result: true },
            { function: 'get', path: 'orgs/org-1', result: { ownerId: 'u1' } },
          ],
        },
      ]);

      expect(simRef.cases[0]?.decision).toBe('ALLOW');
      expect(simRef.cases[0]?.decision).toBe(simPath.cases[0]?.decision);

      setRules(sb, refRulesSource);
      const snap = await getDoc(doc(db, 'items', 'ref-item'));
      expect(snap.exists()).toBe(true);
    }
  });

  test('named-database DocumentReference never equates across database boundaries in Firestore or Storage', async () => {
    const sb = initializeSandbox();
    const dbDefault = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const dbNamed = getFirestore(sb.withAuth({ uid: 'u1', token: {} }), 'reporting');

    await setDoc(doc(dbDefault, 'items', 'doc-1'), {
      namedRef: doc(dbNamed, 'orgs', 'org-1'),
      defaultRef: doc(dbDefault, 'orgs', 'org-1'),
    });

    setRules(
      sb,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        '      allow get: if resource.data.namedRef != resource.data.defaultRef',
        '        && resource.data.namedRef == /databases/reporting/documents/orgs/org-1',
        '        && resource.data.namedRef != /databases/(default)/documents/orgs/org-1;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    expect((await getDoc(doc(dbDefault, 'items', 'doc-1'))).exists()).toBe(true);

    const st = getStorageSandbox(sb.withAuth({ uid: 'u1', token: {} }), {
      dbName: 'fs-rules-eval-diff-storage',
      rules: [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /checked/{id} {',
        '      allow write: if firestore.get(/databases/(default)/documents/items/doc-1).data.namedRef',
        '        == /databases/reporting/documents/orgs/org-1',
        '        && firestore.get(/databases/(default)/documents/items/doc-1).data.namedRef',
        '        != /databases/(default)/documents/orgs/org-1;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    });
    await uploadBytes(storageRef(st, 'checked/obj-1'), new Uint8Array([1]));
  });

  test('writeBatch and runTransaction multi-op ruleMethod selection agrees with single-doc simulate()', async () => {
    const rulesSource = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow read: if true;',
      "      allow create: if request.resource.data.ownerId == request.auth.uid && request.resource.data.stage == 'final';",
      "      allow update: if resource.data.ownerId == request.auth.uid && request.resource.data.ownerId == resource.data.ownerId && request.resource.data.stage == 'final';",
      '      allow delete: if request.auth != null && resource.data.ownerId == request.auth.uid;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const ruleset = firestoreRules(rulesSource);
    const deleteVerdict = ruleset.simulate([
      {
        description: 'net delete on owned doc',
        expectation: 'ALLOW',
        method: 'delete',
        path: 'items/d1',
        auth: { uid: 'u1' },
        resource: { ownerId: 'u1', stage: 'draft' },
      },
    ]).cases[0]?.decision;
    expect(deleteVerdict).toBe('ALLOW');

    const sb = initializeSandbox();
    setRules(sb, rulesSource);
    seedDocuments(sb, {
      'items/b-set-del': { ownerId: 'u1', stage: 'draft' },
      'items/b-upd-del': { ownerId: 'u1', stage: 'draft' },
      'items/tx-upd-del': { ownerId: 'u1', stage: 'draft' },
      'items/b-upd-upd': { ownerId: 'u1', stage: 'draft' },
    });
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

    const batch = writeBatch(db);
    batch.set(doc(db, 'items', 'b-set-del'), { ownerId: 'u1', stage: 'intermediate' });
    batch.delete(doc(db, 'items', 'b-set-del'));
    batch.update(doc(db, 'items', 'b-upd-del'), { stage: 'intermediate' });
    batch.delete(doc(db, 'items', 'b-upd-del'));
    batch.set(doc(db, 'items', 'b-create-upd'), { ownerId: 'u1', stage: 'intermediate' });
    batch.update(doc(db, 'items', 'b-create-upd'), { stage: 'final' });
    batch.update(doc(db, 'items', 'b-upd-upd'), { stage: 'intermediate' });
    batch.update(doc(db, 'items', 'b-upd-upd'), { stage: 'final' });
    await batch.commit();

    await runTransaction(db, async (tx) => {
      const r = doc(db, 'items', 'tx-upd-del');
      await tx.get(r);
      tx.update(r, { stage: 'intermediate' });
      tx.delete(r);
    });

    expect((await getDoc(doc(db, 'items', 'b-set-del'))).exists()).toBe(false);
    expect((await getDoc(doc(db, 'items', 'b-upd-del'))).exists()).toBe(false);
    expect((await getDoc(doc(db, 'items', 'tx-upd-del'))).exists()).toBe(false);
    expect((await getDoc(doc(db, 'items', 'b-create-upd'))).data()).toEqual({ ownerId: 'u1', stage: 'final' });
    expect((await getDoc(doc(db, 'items', 'b-upd-upd'))).data()).toEqual({ ownerId: 'u1', stage: 'final' });
  });
});
