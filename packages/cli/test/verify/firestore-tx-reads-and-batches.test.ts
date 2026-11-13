import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  arrayUnion,
  deleteField,
  doc,
  getDoc,
  getFirestore,
  increment,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
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

  it('round-trips user maps shaped like pyric/map/1.0 envelopes across snapshot, getDoc, and verifyFixture without unwrapping', async () => {
    const ENVELOPE_USER_MAP_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow create, update: if request.auth != null',
      '        && request.resource.data.wrapped is map',
      "        && request.resource.data.wrapped['type'] == 'pyric/map/1.0'",
      '        && request.resource.data.wrapped.fields.k == 1',
      "        && request.resource.data.wrapped.fields.inner['type'] == 'pyric/map/1.0'",
      '        && request.resource.data.wrapped.fields.orgRef == /databases/analytics/documents/orgs/org-1;',
      '      allow get: if request.auth != null',
      '        && resource.data.wrapped is map',
      "        && resource.data.wrapped['type'] == 'pyric/map/1.0'",
      '        && resource.data.wrapped.fields.k == 1',
      "        && resource.data.wrapped.fields.inner['type'] == 'pyric/map/1.0'",
      '        && resource.data.wrapped.fields.orgRef == /databases/analytics/documents/orgs/org-1;',
      '    }',
      '    match /envelopes/{id} {',
      '      allow create, update, get: if request.auth != null',
      "        && (request.method == 'get' ? resource.data['type'] : request.resource.data['type']) == 'pyric/map/1.0';",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const sb = initializeSandbox();
    setRules(sb, ENVELOPE_USER_MAP_RULES);
    const authed = sb.withAuth({ uid: 'u1', token: {} });
    const db = getFirestore(authed);
    const dbAnalytics = getFirestore(authed, 'analytics');

    await setDoc(doc(db, 'items', 'i1'), {
      wrapped: {
        type: 'pyric/map/1.0',
        fields: {
          k: 1,
          inner: { type: 'pyric/map/1.0', fields: { m: 2 } },
          orgRef: doc(dbAnalytics, 'orgs', 'org-1'),
        },
      },
    });
    await getDoc(doc(db, 'items', 'i1'));

    await setDoc(doc(db, 'envelopes', 'top'), {
      type: 'pyric/map/1.0',
      fields: { direct: true },
    });
    await updateDoc(doc(db, 'envelopes', 'top'), { 'fields.extra': 2 });
    await getDoc(doc(db, 'envelopes', 'top'));

    const persistedFixture = JSON.parse(
      JSON.stringify(buildVerifyFixture({ sandbox: sb, firestoreRules: ENVELOPE_USER_MAP_RULES })),
    );
    const verified = await verifyFixture(persistedFixture, {
      rules: { firestore: ENVELOPE_USER_MAP_RULES },
    });
    expect(verified.services.firestore?.divergences).toEqual([]);
    expect(verified.ok).toBe(true);
  });

  it('preserves sequential intra-batch projections for same-path multi-writes in committed and rolled-back batches', async () => {
    const MULTI_WRITE_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow create: if request.auth != null',
      '        && request.resource.data.ownerId == request.auth.uid',
      '        && request.resource.data.count == 15',
      "        && request.resource.data.tags == ['x', 'y']",
      "        && !('temp' in request.resource.data);",
      '      allow delete: if request.auth != null;',
      '    }',
      '    match /audits/{id} {',
      '      allow create: if getAfter(/databases/$(database)/documents/items/a).data.ownerId == request.auth.uid',
      '        && getAfter(/databases/$(database)/documents/items/a).data.count == 15',
      '        && !existsAfter(/databases/$(database)/documents/items/ephemeral);',
      '    }',
      '    match /locked/{id} {',
      '      allow create: if false;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const sbCommitted = initializeSandbox();
    setRules(sbCommitted, MULTI_WRITE_RULES);
    const dbCommitted = getFirestore(sbCommitted.withAuth({ uid: 'u1', token: {} }));
    const committedBatch = writeBatch(dbCommitted);
    committedBatch.set(doc(dbCommitted, 'items', 'a'), {
      ownerId: 'u1',
      count: 10,
      tags: ['x'],
      temp: 'drop',
    });
    committedBatch.update(doc(dbCommitted, 'items', 'a'), {
      count: increment(5),
      tags: arrayUnion('y'),
      temp: deleteField(),
    });
    committedBatch.set(doc(dbCommitted, 'items', 'ephemeral'), { ownerId: 'u1' });
    committedBatch.delete(doc(dbCommitted, 'items', 'ephemeral'));
    committedBatch.set(doc(dbCommitted, 'audits', 'a1'), { ok: true });
    await committedBatch.commit();

    const committedFix = JSON.parse(
      JSON.stringify(buildVerifyFixture({ sandbox: sbCommitted, firestoreRules: MULTI_WRITE_RULES })),
    );
    const verCommitted = await verifyFixture(committedFix, {
      rules: { firestore: MULTI_WRITE_RULES },
    });
    expect(verCommitted.services.firestore?.divergences).toEqual([]);
    expect(verCommitted.ok).toBe(true);

    const sbRolledBack = initializeSandbox();
    setRules(sbRolledBack, MULTI_WRITE_RULES);
    const dbRolledBack = getFirestore(sbRolledBack.withAuth({ uid: 'u1', token: {} }));
    const rolledBackBatch = writeBatch(dbRolledBack);
    rolledBackBatch.set(doc(dbRolledBack, 'items', 'a'), {
      ownerId: 'u1',
      count: 10,
      tags: ['x'],
      temp: 'drop',
    });
    rolledBackBatch.update(doc(dbRolledBack, 'items', 'a'), {
      count: increment(5),
      tags: arrayUnion('y'),
      temp: deleteField(),
    });
    rolledBackBatch.set(doc(dbRolledBack, 'items', 'ephemeral'), { ownerId: 'u1' });
    rolledBackBatch.delete(doc(dbRolledBack, 'items', 'ephemeral'));
    rolledBackBatch.set(doc(dbRolledBack, 'audits', 'a1'), { ok: true });
    rolledBackBatch.set(doc(dbRolledBack, 'locked', 'l1'), { ok: true });
    await expect(rolledBackBatch.commit()).rejects.toThrow();

    const rolledBackFix = JSON.parse(
      JSON.stringify(buildVerifyFixture({ sandbox: sbRolledBack, firestoreRules: MULTI_WRITE_RULES })),
    );
    const derivedRolledBack = deriveRulesTestCases(rolledBackFix, { mockReads: 'omit' });
    expect(derivedRolledBack.ok).toBe(true);
    const itemACases = derivedRolledBack.testCases.filter((tc) => tc.path === 'items/a');
    expect(itemACases).toHaveLength(2);
    for (const tc of itemACases) {
      expect(tc.data).toEqual({ ownerId: 'u1', count: 15, tags: ['x', 'y'] });
    }

    const verRolledBack = await verifyFixture(rolledBackFix, {
      rules: { firestore: MULTI_WRITE_RULES },
    });
    expect(verRolledBack.services.firestore?.divergences).toEqual([]);
    expect(verRolledBack.ok).toBe(true);
  });

  it('distinguishes structural write-preparation errors from Security Rules denials in history, deriveRulesTestCases, and verifyFixture', async () => {
    const PREP_VS_DENY_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow create, update, delete: if request.auth != null;',
      '    }',
      '    match /locked/{id} {',
      '      allow create, update, delete: if false;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const OPENED_LOCKED_RULES = PREP_VS_DENY_RULES.replace(
      'allow create, update, delete: if false;',
      'allow create, update, delete: if request.auth != null;',
    );

    const sb = initializeSandbox();
    setRules(sb, PREP_VS_DENY_RULES);
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    await setDoc(doc(db, 'items', 'i1'), { count: 1 });

    const badBatch = writeBatch(db);
    badBatch.delete(doc(db, 'items', 'i1'));
    badBatch.update(doc(db, 'items', 'i1'), { count: 2 });
    await expect(badBatch.commit()).rejects.toMatchObject({ code: 'invalid-argument' });

    await expect(
      runTransaction(db, async (tx) => {
        tx.delete(doc(db, 'items', 'i1'));
        tx.update(doc(db, 'items', 'i1'), { count: 3 });
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    const deniedBatch = writeBatch(db);
    deniedBatch.set(doc(db, 'locked', 'l1'), { count: 1 });
    await expect(deniedBatch.commit()).rejects.toMatchObject({ code: 'permission-denied' });

    const persisted = JSON.parse(
      JSON.stringify(buildVerifyFixture({ sandbox: sb, firestoreRules: PREP_VS_DENY_RULES })),
    );

    const prepEvents = persisted.events.filter(
      (e: { kind?: string; path?: string; result?: string }) =>
        e.kind === 'request' && e.path === 'items/i1' && e.result === 'deny',
    );
    expect(prepEvents.length).toBeGreaterThanOrEqual(2);
    for (const prep of prepEvents) {
      expect(prep.rulesDisposition).toEqual({
        kind: 'not-evaluated',
        reason: 'runtime-error',
      });
    }

    const derived = deriveRulesTestCases(persisted);
    expect(derived.ok).toBe(true);
    expect(derived.testCases.map((tc) => `${tc.expectation}:${tc.method}:${tc.path}`)).toEqual([
      'ALLOW:create:items/i1',
      'DENY:create:locked/l1',
    ]);

    const sameVerify = await verifyFixture(persisted, {
      rules: { firestore: PREP_VS_DENY_RULES },
    });
    expect(sameVerify.services.firestore?.divergences).toEqual([]);
    expect(sameVerify.ok).toBe(true);

    const openedVerify = await verifyFixture(persisted, {
      rules: { firestore: OPENED_LOCKED_RULES },
    });
    expect(openedVerify.ok).toBe(false);
    expect(openedVerify.services.firestore?.divergences).toContainEqual(
      expect.objectContaining({
        service: 'firestore',
        kind: 'now-allowed',
        path: 'locked/l1',
      }),
    );
  });
});




