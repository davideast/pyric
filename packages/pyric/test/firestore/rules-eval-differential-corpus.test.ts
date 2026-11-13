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

  test('SD:FS-RULES-EVAL standing corpus: lookup and Reference path normalization boundaries agree across simulate() and Sandbox', async () => {
    const sb = initializeSandbox();
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const dbArchive = getFirestore(sb.withAuth({ uid: 'u1', token: {} }), 'archive');

    seedDocuments(sb, {
      'admins/u1': { isAdmin: true },
      '_extra/u1': { isAdmin: true },
      'documents/d1': { ok: true },
      'orgs/documents/members/u1': { role: 'member' },
      'orgs/org-1/documents/doc-1': { tenant: 'org-1' },
      'orgs/org-2/documents/doc-1': { tenant: 'org-2' },
      'items/target': {
        topDocsRef: doc(db, 'documents', 'd1'),
        docIdDocsRef: doc(db, 'orgs', 'documents', 'members', 'u1'),
        org1DocsRef: doc(db, 'orgs', 'org-1', 'documents', 'doc-1'),
        org2DocsRef: doc(db, 'orgs', 'org-2', 'documents', 'doc-1'),
        archiveDocsRef: doc(dbArchive, 'orgs', 'org-1', 'documents', 'doc-1'),
      },
    });

    const corpus: Array<{
      name: string;
      condition: string;
      expected: 'ALLOW' | 'DENY';
    }> = [
      {
        name: 'canonical /databases/$(database)/documents/admins/$(uid) lookup',
        condition: 'exists(/databases/$(database)/documents/admins/$(request.auth.uid)) && get(/databases/$(database)/documents/admins/$(request.auth.uid)).data.isAdmin == true',
        expected: 'ALLOW',
      },
      {
        name: 'user collection named documents at root',
        condition: 'exists(/databases/$(database)/documents/documents/d1) && resource.data.topDocsRef == /databases/$(database)/documents/documents/d1',
        expected: 'ALLOW',
      },
      {
        name: 'document ID named documents preserves full prefix and does not spoof root',
        condition: 'resource.data.docIdDocsRef == /databases/$(database)/documents/orgs/documents/members/u1 && resource.data.docIdDocsRef != /databases/$(database)/documents/members/u1 && get(resource.data.docIdDocsRef).data.role == "member"',
        expected: 'ALLOW',
      },
      {
        name: 'subcollection named documents isolates cross-tenant references and named databases',
        condition: 'resource.data.org1DocsRef != resource.data.org2DocsRef && resource.data.org1DocsRef != resource.data.archiveDocsRef && resource.data.archiveDocsRef == /databases/archive/documents/orgs/org-1/documents/doc-1',
        expected: 'ALLOW',
      },
      {
        name: 'concatenated /databases/$(database)/documentsadmins/... boundary prefix fails closed',
        condition: 'exists(/databases/$(database)/documentsadmins/$(request.auth.uid))',
        expected: 'DENY',
      },
      {
        name: 'negated !exists on /databases/$(database)/documents_extra/... fails closed (EvalError, not false)',
        condition: '!exists(/databases/$(database)/documents_extra/$(request.auth.uid))',
        expected: 'DENY',
      },
      {
        name: 'exact /databases/$(database)/documents root without document segments fails closed',
        condition: '!exists(path("/databases/(default)/documents"))',
        expected: 'DENY',
      },
      {
        name: 'truncated /databases/(default) two-segment path fails closed',
        condition: '!exists(path("/databases/(default)"))',
        expected: 'DENY',
      },
      {
        name: 'foreign named database lookup inFirestore rules fails closed',
        condition: '!exists(/databases/archive/documents/orgs/org-1/documents/doc-1)',
        expected: 'DENY',
      },
    ];

    const simMocks = [
      { function: 'exists' as const, path: 'admins/u1', result: true },
      { function: 'get' as const, path: 'admins/u1', result: { isAdmin: true } },
      { function: 'exists' as const, path: '_extra/u1', result: true },
      { function: 'exists' as const, path: 'documents/d1', result: true },
      { function: 'get' as const, path: 'orgs/documents/members/u1', result: { role: 'member' } },
    ];
    const simResource = {
      topDocsRef: reference('documents/d1'),
      docIdDocsRef: reference('orgs/documents/members/u1'),
      org1DocsRef: reference('orgs/org-1/documents/doc-1'),
      org2DocsRef: reference('orgs/org-2/documents/doc-1'),
      archiveDocsRef: reference('/databases/archive/documents/orgs/org-1/documents/doc-1'),
    };

    for (const entry of corpus) {
      const rulesSource = [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        `      allow get: if ${entry.condition};`,
        '    }',
        '  }',
        '}',
      ].join('\n');

      const simResult = firestoreRules(rulesSource).simulate([
        {
          description: entry.name,
          expectation: entry.expected,
          method: 'get',
          path: 'items/target',
          auth: { uid: 'u1' },
          resource: simResource,
          functionMocks: simMocks,
        },
      ]);
      expect(simResult.cases[0]?.decision).toBe(entry.expected);

      setRules(sb, rulesSource);
      if (entry.expected === 'ALLOW') {
        expect((await getDoc(doc(db, 'items', 'target'))).exists()).toBe(true);
      } else {
        await expect(getDoc(doc(db, 'items', 'target'))).rejects.toMatchObject({
          code: 'permission-denied',
        });
      }
    }

    // Batch getAfter / existsAfter on malformed /databases/$(database)/documentsadmins/... also fails closed.
    setRules(
      sb,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /admins/{uid} { allow create: if true; }',
        '    match /batchItems/{id} {',
        '      allow create: if existsAfter(/databases/$(database)/documentsadmins/$(request.auth.uid))',
        '        && getAfter(/databases/$(database)/documentsadmins/$(request.auth.uid)).data.isAdmin == true;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    const dbU2 = getFirestore(sb.withAuth({ uid: 'u2', token: {} }));
    const batch = writeBatch(dbU2);
    batch.set(doc(dbU2, 'admins', 'u2'), { isAdmin: true });
    batch.set(doc(dbU2, 'batchItems', 'b1'), { ok: true });
    await expect(batch.commit()).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
