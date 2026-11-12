import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  doc,
  getFirestore,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'pyric/firestore';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  buildVerifyFixture,
  deriveRulesTestCases,
  verifyFixture,
} from '../../src/verify/index.js';

describe('verifyFixture Firestore transaction tx.get() fail-closed history', () => {
  const INITIAL_RULES = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /orgs/{orgId} {',
    '      allow get: if request.auth != null && resource.data.owner == request.auth.uid;',
    '      allow update: if request.auth != null;',
    '    }',
    '    match /items/{id} {',
    '      allow create, update: if request.auth != null;',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const TIGHTENED_READ_RULES = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /orgs/{orgId} {',
    '      allow get: if false;',
    '      allow update: if request.auth != null;',
    '    }',
    '    match /items/{id} {',
    '      allow create, update: if request.auth != null;',
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('records allowed tx.get() reads in history(), derives get test cases, and flags now-denied in read-write transactions', async () => {
    const sb = initializeSandbox();
    setRules(sb, INITIAL_RULES);
    seedDocuments(sb, {
      'orgs/o1': { owner: 'u1', quota: 5 },
    });

    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    await runTransaction(db, async (tx) => {
      const orgSnap = await tx.get(doc(db, 'orgs', 'o1'));
      if (!orgSnap.exists()) throw new Error('missing org');
      tx.set(doc(db, 'items', 'i1'), { quota: orgSnap.data().quota });
    });

    const fixture = buildVerifyFixture({
      sandbox: sb,
      firestoreRules: INITIAL_RULES,
    });
    const derived = deriveRulesTestCases(fixture);
    const getCases = derived.testCases.filter((tc) => tc.method === 'get');
    expect(getCases).toHaveLength(1);
    expect(getCases[0]).toMatchObject({
      method: 'get',
      path: 'orgs/o1',
      expectation: 'ALLOW',
      resource: { owner: 'u1', quota: 5 },
    });

    const sameVerify = await verifyFixture(fixture, {
      rules: { firestore: INITIAL_RULES },
    });
    expect(sameVerify.ok).toBe(true);
    expect(sameVerify.services.firestore?.divergences).toEqual([]);

    const tightenedVerify = await verifyFixture(fixture, {
      rules: { firestore: TIGHTENED_READ_RULES },
    });
    expect(tightenedVerify.ok).toBe(false);
    expect(tightenedVerify.services.firestore?.divergences).toContainEqual(
      expect.objectContaining({
        service: 'firestore',
        kind: 'now-denied',
        method: 'get',
        path: 'orgs/o1',
      }),
    );
  });

  it('records allowed tx.get() reads in read-only transactions and preserves point-in-time document state across later writes', async () => {
    const sb = initializeSandbox();
    setRules(sb, INITIAL_RULES);
    seedDocuments(sb, {
      'orgs/o1': { owner: 'u1', quota: 5 },
      'orgs/o2': { owner: 'u1', quota: 10 },
    });

    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const total = await runTransaction(db, async (tx) => {
      const s1 = await tx.get(doc(db, 'orgs', 'o1'));
      const s2 = await tx.get(doc(db, 'orgs', 'o2'));
      return Number(s1.data()?.quota ?? 0) + Number(s2.data()?.quota ?? 0);
    });
    expect(total).toBe(15);

    // Later write transfers ownership of orgs/o2 to u2; the earlier tx.get(orgs/o2) must still verify against { owner: 'u1' }!
    await setDoc(doc(db, 'orgs', 'o2'), { owner: 'u2', quota: 10 });

    const fixture = buildVerifyFixture({
      sandbox: sb,
      firestoreRules: INITIAL_RULES,
    });
    const sameVerify = await verifyFixture(fixture, {
      rules: { firestore: INITIAL_RULES },
    });
    expect(sameVerify.ok).toBe(true);
    expect(sameVerify.services.firestore?.divergences).toEqual([]);

    const tightenedVerify = await verifyFixture(fixture, {
      rules: { firestore: TIGHTENED_READ_RULES },
    });
    expect(tightenedVerify.ok).toBe(false);
    const deniedPaths = (tightenedVerify.services.firestore?.divergences ?? [])
      .filter((d) => d.kind === 'now-denied' && d.method === 'get')
      .map((d) => d.path);
    expect(deniedPaths).toEqual(['orgs/o1', 'orgs/o2']);
  });
});

describe('verifyFixture rolled-back atomic batch getAfter() serverTimestamp() resolution', () => {
  const CAPTURED_BATCH_RULES = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /items/a {',
    '      allow create, update: if request.auth != null;',
    '    }',
    '    match /items/b {',
    '      allow create, update: if request.auth != null',
    '        && getAfter(/databases/$(database)/documents/items/a).data.updatedAt == request.time',
    '        && getAfter(/databases/$(database)/documents/items/a).data.nested.touchedAt == request.time',
    '        && getAfter(/databases/$(database)/documents/items/a).data.stamps[0] == request.time;',
    '    }',
    '    match /items/c {',
    '      allow create, update: if false;',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const OPENED_BATCH_RULES = CAPTURED_BATCH_RULES.replace(
    'allow create, update: if false;',
    [
      'allow create, update: if request.auth != null',
      '        && getAfter(/databases/$(database)/documents/items/a).data.updatedAt == request.time;',
    ].join('\n'),
  );

  it('resolves serverTimestamp() sentinels in getAfter() projections for rolled-back writeBatch and runTransaction groups', async () => {
    for (const mode of ['writeBatch', 'runTransaction'] as const) {
      const sb = initializeSandbox();
      getClock(sb).set(1_700_000_000_000);
      setRules(sb, CAPTURED_BATCH_RULES);
      const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

      if (mode === 'writeBatch') {
        const b = writeBatch(db);
        b.set(doc(db, 'items', 'a'), {
          updatedAt: serverTimestamp(),
          nested: { touchedAt: serverTimestamp() },
          stamps: [serverTimestamp()],
        });
        b.set(doc(db, 'items', 'b'), { ok: true });
        b.set(doc(db, 'items', 'c'), { ok: true });
        await expect(b.commit()).rejects.toThrow();
      } else {
        await expect(
          runTransaction(db, async (tx) => {
            tx.set(doc(db, 'items', 'a'), {
              updatedAt: serverTimestamp(),
              nested: { touchedAt: serverTimestamp() },
              stamps: [serverTimestamp()],
            });
            tx.set(doc(db, 'items', 'b'), { ok: true });
            tx.set(doc(db, 'items', 'c'), { ok: true });
          }),
        ).rejects.toThrow();
      }

      const fixture = buildVerifyFixture({
        sandbox: sb,
        firestoreRules: CAPTURED_BATCH_RULES,
      });

      const sameVerify = await verifyFixture(fixture, {
        rules: { firestore: CAPTURED_BATCH_RULES },
      });
      expect(sameVerify.services.firestore?.divergences).toEqual([]);
      expect(sameVerify.ok).toBe(true);

      const openedVerify = await verifyFixture(fixture, {
        rules: { firestore: OPENED_BATCH_RULES },
      });
      expect(openedVerify.ok).toBe(false);
      expect(openedVerify.services.firestore?.divergences).toContainEqual(
        expect.objectContaining({
          service: 'firestore',
          kind: 'now-allowed',
          path: 'items/c',
        }),
      );
    }
  });

  it('distinguishes serverTimestamp() sentinels from literal and pyric/map/1.0-escaped user maps in committed and rolled-back batches', async () => {
    const ESCAPED_MAP_BATCH_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/a {',
      '      allow create, update: if request.auth != null',
      '        && request.resource.data.ts == request.time',
      '        && request.resource.data.payload is map',
      "        && request.resource.data.payload['__type'] == 'serverTimestamp'",
      '        && request.resource.data.floatMap is map',
      "        && request.resource.data.floatMap['__type'] == 'float'",
      '        && request.resource.data.floatMap.value == 1.5;',
      '    }',
      '    match /items/b {',
      '      allow create, update: if request.auth != null',
      '        && getAfter(/databases/$(database)/documents/items/a).data.ts == request.time',
      '        && getAfter(/databases/$(database)/documents/items/a).data.payload is map',
      "        && getAfter(/databases/$(database)/documents/items/a).data.payload['__type'] == 'serverTimestamp'",
      '        && getAfter(/databases/$(database)/documents/items/a).data.floatMap is map',
      "        && getAfter(/databases/$(database)/documents/items/a).data.floatMap['__type'] == 'float'",
      '        && getAfter(/databases/$(database)/documents/items/a).data.floatMap.value == 1.5;',
      '    }',
      '    match /items/c {',
      '      allow create, update: if false;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    // 1. Committed writeBatch (in-memory and JSON-roundtripped fixture)
    const sbCommitted = initializeSandbox();
    getClock(sbCommitted).set(1_700_000_000_000);
    setRules(sbCommitted, ESCAPED_MAP_BATCH_RULES);
    const dbCommitted = getFirestore(sbCommitted.withAuth({ uid: 'u1', token: {} }));
    const committedBatch = writeBatch(dbCommitted);
    committedBatch.set(doc(dbCommitted, 'items', 'a'), {
      ts: serverTimestamp(),
      payload: { __type: 'serverTimestamp' },
      floatMap: { __type: 'float', value: 1.5 },
    });
    committedBatch.set(doc(dbCommitted, 'items', 'b'), { ok: true });
    await committedBatch.commit();

    const committedFixture = JSON.parse(
      JSON.stringify(
        buildVerifyFixture({
          sandbox: sbCommitted,
          firestoreRules: ESCAPED_MAP_BATCH_RULES,
        }),
      ),
    );
    const committedVerify = await verifyFixture(committedFixture, {
      rules: { firestore: ESCAPED_MAP_BATCH_RULES },
    });
    expect(committedVerify.services.firestore?.divergences).toEqual([]);
    expect(committedVerify.ok).toBe(true);

    // 2. Rolled-back writeBatch (in-memory and JSON-roundtripped pyric/map/1.0 fixture)
    const sbRolledBack = initializeSandbox();
    getClock(sbRolledBack).set(1_700_000_000_000);
    setRules(sbRolledBack, ESCAPED_MAP_BATCH_RULES);
    const dbRolledBack = getFirestore(sbRolledBack.withAuth({ uid: 'u1', token: {} }));
    const rolledBackBatch = writeBatch(dbRolledBack);
    rolledBackBatch.set(doc(dbRolledBack, 'items', 'a'), {
      ts: serverTimestamp(),
      payload: { __type: 'serverTimestamp' },
      floatMap: { __type: 'float', value: 1.5 },
    });
    rolledBackBatch.set(doc(dbRolledBack, 'items', 'b'), { ok: true });
    rolledBackBatch.set(doc(dbRolledBack, 'items', 'c'), { ok: true });
    await expect(rolledBackBatch.commit()).rejects.toThrow();

    const rawRolledBackFixture = buildVerifyFixture({
      sandbox: sbRolledBack,
      firestoreRules: ESCAPED_MAP_BATCH_RULES,
    });
    const jsonRolledBackFixture = JSON.parse(JSON.stringify(rawRolledBackFixture));

    for (const candidateFixture of [rawRolledBackFixture, jsonRolledBackFixture]) {
      const verifySame = await verifyFixture(candidateFixture, {
        rules: { firestore: ESCAPED_MAP_BATCH_RULES },
      });
      expect(verifySame.services.firestore?.divergences).toEqual([]);
      expect(verifySame.ok).toBe(true);
    }
  });
});

