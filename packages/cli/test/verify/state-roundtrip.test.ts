import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  apply,
  applyFullState,
  captureFullState,
  fork,
  getClock,
  initializeSandbox,
  replay,
  toOperationRecord,
} from 'pyric/sandbox';
import {
  arrayUnion,
  Bytes,
  deleteField,
  doc,
  GeoPoint,
  getDoc,
  getFirestore,
  increment,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  VectorValue,
  writeBatch,
} from 'pyric/firestore';
import { seedDocuments, setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import {
  getBytes,
  getStorageSandbox,
  ref as storageRef,
  uploadString,
} from 'pyric/storage';
import {
  buildVerifyFixture,
  deriveRulesTestCases,
  fixtureVerifiableServices,
  parseVerifyFixture,
  verifyFixture,
} from '../../src/verify/index.js';

let nextStorageSeq = 1;
function uniqueStorageDb(prefix: string): string {
  return `state-roundtrip-${prefix}:${nextStorageSeq++}`;
}

describe('STATE-ROUNDTRIP standing coverage for replay and verifyFixture', () => {
  it('round-trips DocumentReference values with named databaseId and default database across codecs, replay, and verifyFixture', async () => {
    const NAMED_REF_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow create, update: if request.auth != null',
      '        && request.resource.data.tenantRef is path',
      '        && request.resource.data.tenantRef == /databases/tenant-db/documents/orgs/o1',
      '        && request.resource.data.defaultRef is path',
      '        && request.resource.data.defaultRef == /databases/(default)/documents/users/$(request.auth.uid)',
      '        && request.resource.data.nested.analyticsRef == /databases/analytics-db/documents/docs/d1;',
      '      allow get: if request.auth != null',
      '        && resource.data.tenantRef == /databases/tenant-db/documents/orgs/o1',
      '        && resource.data.defaultRef == /databases/(default)/documents/users/$(request.auth.uid)',
      '        && resource.data.nested.analyticsRef == /databases/analytics-db/documents/docs/d1;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const TIGHTENED_NAMED_REF_RULES = NAMED_REF_RULES.replaceAll(
      '/databases/tenant-db/documents/orgs/o1',
      '/databases/other-db/documents/orgs/o1',
    );

    const sb = initializeSandbox();
    setRules(sb, NAMED_REF_RULES);
    const authed = sb.withAuth({ uid: 'u1', token: {} });
    const defaultDb = getFirestore(authed);
    const tenantDb = getFirestore(authed, 'tenant-db');
    const analyticsDb = getFirestore(authed, 'analytics-db');

    const tenantRef = doc(tenantDb, 'orgs', 'o1');
    const defaultRef = doc(defaultDb, 'users', 'u1');
    const analyticsRef = doc(analyticsDb, 'docs', 'd1');
    const altAnalyticsRef = doc(analyticsDb, 'docs', 'd1');

    // Single write + update + read
    await setDoc(doc(defaultDb, 'items', 'single'), {
      tenantRef,
      defaultRef,
      nested: { analyticsRef },
    });
    await updateDoc(doc(defaultDb, 'items', 'single'), {
      'nested.analyticsRef': altAnalyticsRef,
    });
    const singleSnap = await getDoc(doc(defaultDb, 'items', 'single'));
    expect(singleSnap.exists()).toBe(true);

    // Atomic batch write with named-DB references
    const batch = writeBatch(defaultDb);
    batch.set(doc(defaultDb, 'items', 'batched'), {
      tenantRef,
      defaultRef,
      nested: { analyticsRef },
    });
    await batch.commit();

    // Transaction write with named-DB references
    await runTransaction(defaultDb, async (tx) => {
      tx.set(doc(defaultDb, 'items', 'transacted'), {
        tenantRef,
        defaultRef,
        nested: { analyticsRef },
      });
    });

    // 1. JSON-serialized replay() preserves named databaseId without state drift
    const wireHistory = JSON.parse(JSON.stringify(sb.history()));
    const replayed = replay(wireHistory, NAMED_REF_RULES, {}, snapshotDocuments(sb));
    expect(replayed.divergences).toEqual([]);

    // 2. captureFullState -> JSON -> applyFullState preserves named databaseId for subsequent reads
    const capturedFull = JSON.parse(JSON.stringify(await captureFullState(sb)));
    const restoredFull = initializeSandbox();
    await applyFullState(restoredFull, capturedFull);
    const restoredSnap = await getDoc(
      doc(getFirestore(restoredFull.withAuth({ uid: 'u1', token: {} })), 'items', 'single'),
    );
    expect(restoredSnap.exists()).toBe(true);

    // 3. buildVerifyFixture -> JSON -> parseVerifyFixture -> deriveRulesTestCases + verifyFixture
    const fixture = parseVerifyFixture(
      JSON.parse(
        JSON.stringify(
          buildVerifyFixture({
            sandbox: sb,
            firestoreRules: NAMED_REF_RULES,
          }),
        ),
      ),
    );
    const derived = deriveRulesTestCases(fixture);
    expect(derived.testCases.length).toBeGreaterThanOrEqual(4);

    const sameVerify = await verifyFixture(fixture, {
      rules: { firestore: NAMED_REF_RULES },
    });
    expect(sameVerify.services.firestore?.divergences).toEqual([]);
    expect(sameVerify.ok).toBe(true);

    const tightenedVerify = await verifyFixture(fixture, {
      rules: { firestore: TIGHTENED_NAMED_REF_RULES },
    });
    expect(tightenedVerify.ok).toBe(false);
    expect(tightenedVerify.services.firestore?.divergences.some((d) => d.kind === 'now-denied')).toBe(
      true,
    );
  });

  it('round-trips arbitrary user maps shaped like pyric/map/1.0 envelopes alongside real wrappers and marker-shaped maps verbatim', async () => {
    const ENVELOPE_MAP_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/top {',
      '      allow create, update: if request.auth != null',
      "        && request.resource.data['type'] == 'pyric/map/1.0'",
      '        && request.resource.data.fields.count == 7;',
      '      allow get: if request.auth != null',
      "        && resource.data['type'] == 'pyric/map/1.0'",
      '        && resource.data.fields.count == 7;',
      '    }',
      '    match /items/seeded {',
      '      allow get: if request.auth != null',
      "        && resource.data['type'] == 'pyric/map/1.0'",
      "        && resource.data.fields.origin == 'seed';",
      '    }',
      '    match /items/adminDoc {',
      '      allow get: if request.auth != null',
      "        && resource.data['type'] == 'pyric/map/1.0'",
      "        && resource.data.fields.origin == 'admin';",
      '    }',
      '    match /items/kitchen {',
      '      allow create, update: if request.auth != null',
      "        && request.resource.data.wrapped['type'] == 'pyric/map/1.0'",
      '        && request.resource.data.wrapped.fields.k == 1',
      "        && request.resource.data.wrapped.fields.inner['type'] == 'pyric/map/1.0'",
      "        && request.resource.data.wrapped.fields.inner.fields.deep == 'yes'",
      "        && request.resource.data.list[0]['type'] == 'pyric/map/1.0'",
      "        && request.resource.data.sentinelLookalike['__type'] == 'serverTimestamp'",
      "        && request.resource.data.tsLookalike['type'] == 'firestore/timestamp/1.0'",
      '        && request.resource.data.realTs is timestamp',
      '        && request.resource.data.realBytes is bytes',
      '        && request.resource.data.realGeo is latlng',
      '        && request.resource.data.namedRef == /databases/tenant-db/documents/orgs/o9;',
      '      allow get: if request.auth != null',
      "        && resource.data.wrapped['type'] == 'pyric/map/1.0'",
      "        && resource.data.wrapped.fields.inner['type'] == 'pyric/map/1.0'",
      "        && resource.data.list[0]['type'] == 'pyric/map/1.0'",
      "        && resource.data.sentinelLookalike['__type'] == 'serverTimestamp'",
      "        && resource.data.tsLookalike['type'] == 'firestore/timestamp/1.0'",
      '        && resource.data.realTs is timestamp',
      '        && resource.data.namedRef == /databases/tenant-db/documents/orgs/o9;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const sb = initializeSandbox();
    getClock(sb).set(1_735_000_000_000);
    setRules(sb, ENVELOPE_MAP_RULES);
    seedDocuments(sb, {
      'items/seeded': {
        type: 'pyric/map/1.0',
        fields: { origin: 'seed' },
      },
    });
    sb.admin.setDocument('items/adminDoc', {
      type: 'pyric/map/1.0',
      fields: { origin: 'admin' },
    });

    const authed = sb.withAuth({ uid: 'u1', token: {} });
    const db = getFirestore(authed);
    const tenantDb = getFirestore(authed, 'tenant-db');

    // Exact 2-key top-level pyric/map/1.0 user document
    await setDoc(doc(db, 'items', 'top'), {
      type: 'pyric/map/1.0',
      fields: { count: 7 },
    });
    const topSnap = await getDoc(doc(db, 'items', 'top'));
    expect(topSnap.data()).toEqual({
      type: 'pyric/map/1.0',
      fields: { count: 7 },
    });

    // Seeded and admin-written exact 2-key pyric/map/1.0 document reads
    const seededSnap = await getDoc(doc(db, 'items', 'seeded'));
    expect(seededSnap.data()).toEqual({
      type: 'pyric/map/1.0',
      fields: { origin: 'seed' },
    });
    const adminSnap = await getDoc(doc(db, 'items', 'adminDoc'));
    expect(adminSnap.data()).toEqual({
      type: 'pyric/map/1.0',
      fields: { origin: 'admin' },
    });

    // Kitchen-sink document mixing nested/doubly-nested/array pyric/map/1.0 maps, colliding marker maps, and real SDK wrappers
    await setDoc(doc(db, 'items', 'kitchen'), {
      wrapped: {
        type: 'pyric/map/1.0',
        fields: {
          k: 1,
          inner: { type: 'pyric/map/1.0', fields: { deep: 'yes' } },
        },
      },
      list: [{ type: 'pyric/map/1.0', fields: { idx: 0 } }],
      sentinelLookalike: { __type: 'serverTimestamp' },
      tsLookalike: { type: 'firestore/timestamp/1.0', seconds: 9, nanoseconds: 0 },
      realTs: new Timestamp(1_735_000_000, 500_000),
      realBytes: Bytes.fromUint8Array(new Uint8Array([4, 5, 6])),
      realGeo: new GeoPoint(37.5, -122.25),
      realVec: VectorValue.create([0.5, -0.25]),
      serverTs: serverTimestamp(),
      namedRef: doc(tenantDb, 'orgs', 'o9'),
    });
    const kitchenSnap = await getDoc(doc(db, 'items', 'kitchen'));
    expect(kitchenSnap.data()?.wrapped).toEqual({
      type: 'pyric/map/1.0',
      fields: {
        k: 1,
        inner: { type: 'pyric/map/1.0', fields: { deep: 'yes' } },
      },
    });
    expect(kitchenSnap.data()?.list).toEqual([{ type: 'pyric/map/1.0', fields: { idx: 0 } }]);
    expect(kitchenSnap.data()?.sentinelLookalike).toEqual({ __type: 'serverTimestamp' });
    expect(kitchenSnap.data()?.tsLookalike).toEqual({
      type: 'firestore/timestamp/1.0',
      seconds: 9,
      nanoseconds: 0,
    });

    // 1. snapshot() -> loadSnapshot() preserves unescaped tag and exact values
    const snapCopy = initializeSandbox();
    snapCopy.loadSnapshot(sb.snapshot());
    const snapCopyTop = await getDoc(
      doc(getFirestore(snapCopy.withAuth({ uid: 'u1', token: {} })), 'items', 'top'),
    );
    expect(snapCopyTop.data()).toEqual({
      type: 'pyric/map/1.0',
      fields: { count: 7 },
    });

    // 2. captureFullState() -> JSON -> applyFullState() preserves all shapes
    const fullCopy = initializeSandbox();
    await applyFullState(fullCopy, JSON.parse(JSON.stringify(await captureFullState(sb))));
    const fullCopyDb = getFirestore(fullCopy.withAuth({ uid: 'u1', token: {} }));
    expect((await getDoc(doc(fullCopyDb, 'items', 'top'))).data()).toEqual({
      type: 'pyric/map/1.0',
      fields: { count: 7 },
    });
    expect((await getDoc(doc(fullCopyDb, 'items', 'seeded'))).data()).toEqual({
      type: 'pyric/map/1.0',
      fields: { origin: 'seed' },
    });
    expect((await getDoc(doc(fullCopyDb, 'items', 'adminDoc'))).data()).toEqual({
      type: 'pyric/map/1.0',
      fields: { origin: 'admin' },
    });
    expect((await getDoc(doc(fullCopyDb, 'items', 'kitchen'))).data()?.wrapped).toEqual({
      type: 'pyric/map/1.0',
      fields: {
        k: 1,
        inner: { type: 'pyric/map/1.0', fields: { deep: 'yes' } },
      },
    });

    // 3. In-memory replay() preserves unescaped user maps cleanly
    const expectedReplayDocs = snapshotDocuments(sb);
    delete expectedReplayDocs['items/seeded'];
    const inMemoryReplay = replay(sb.history(), ENVELOPE_MAP_RULES, {}, expectedReplayDocs);
    expect(inMemoryReplay.divergences).toEqual([]);

    // 4. buildVerifyFixture -> JSON -> parseVerifyFixture -> verifyFixture round-trips losslessly
    const rawFixture = buildVerifyFixture({
      sandbox: sb,
      firestoreRules: ENVELOPE_MAP_RULES,
    });
    const wireFixture = parseVerifyFixture(JSON.parse(JSON.stringify(rawFixture)));

    for (const candidate of [rawFixture, wireFixture]) {
      const verified = await verifyFixture(candidate, {
        rules: { firestore: ENVELOPE_MAP_RULES },
      });
      expect(verified.services.firestore?.divergences).toEqual([]);
      expect(verified.ok).toBe(true);
    }
  });

  it('projects same-path multi-write atomic batches sequentially across replay, branch apply, deriveRulesTestCases, and verifyFixture', async () => {
    const MULTI_WRITE_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/createUpdate {',
      '      allow create, update: if request.auth != null',
      "        && request.resource.data.owner == request.auth.uid",
      '        && request.resource.data.count == 3',
      "        && request.resource.data.tags == ['a', 'b']",
      "        && !('temp' in request.resource.data);",
      '    }',
      '    match /items/setMerge {',
      '      allow create, update: if request.auth != null',
      "        && request.resource.data.base == 'kept'",
      "        && request.resource.data.merged == 'added'",
      "        && request.resource.data.masked == 'picked'",
      "        && !('ignored' in request.resource.data);",
      '    }',
      '    match /items/setDelete {',
      '      allow create, update, delete: if request.auth != null;',
      '    }',
      '    match /items/deleteSet {',
      '      allow create, update, delete: if request.auth != null',
      '        && (request.method == "delete" || (request.resource.data.reborn == true && !("legacy" in request.resource.data)));',
      '    }',
      '    match /items/gate {',
      '      allow create, update: if request.resource.data.allowGate == true;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const TIGHTENED_COUNT_RULES = MULTI_WRITE_RULES.replace(
      'request.resource.data.count == 3',
      'request.resource.data.count == 99',
    );

    const sb = initializeSandbox();
    getClock(sb).set(1_735_100_000_000);
    setRules(sb, MULTI_WRITE_RULES);
    sb.admin.setDocument('items/deleteSet', { legacy: 'old' });
    const baseState = await captureFullState(sb);
    const postSeedHistoryIndex = sb.history().length;

    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

    // 1. Committed multi-write batch exercising create->update, set->merge->mergeFields, set->delete, and delete->set
    const committedBatch = writeBatch(db);
    committedBatch.set(doc(db, 'items', 'createUpdate'), {
      owner: 'u1',
      count: 1,
      tags: ['a'],
      temp: 'drop-me',
    });
    committedBatch.update(doc(db, 'items', 'createUpdate'), {
      count: increment(2),
      tags: arrayUnion('b'),
      temp: deleteField(),
    });

    committedBatch.set(doc(db, 'items', 'setMerge'), { base: 'kept' });
    committedBatch.set(doc(db, 'items', 'setMerge'), { merged: 'added' }, { merge: true });
    committedBatch.set(
      doc(db, 'items', 'setMerge'),
      { masked: 'picked', ignored: 'skipped' },
      { mergeFields: ['masked'] },
    );

    committedBatch.set(doc(db, 'items', 'setDelete'), { ephemeral: true });
    committedBatch.delete(doc(db, 'items', 'setDelete'));

    committedBatch.delete(doc(db, 'items', 'deleteSet'));
    committedBatch.set(doc(db, 'items', 'deleteSet'), { reborn: true });

    committedBatch.set(doc(db, 'items', 'gate'), { allowGate: true });
    await committedBatch.commit();

    // Replay over JSON wire history + Branch apply()
    const fullWireHistory = JSON.parse(JSON.stringify(sb.history()));
    const replayCommitted = replay(fullWireHistory, MULTI_WRITE_RULES, {}, snapshotDocuments(sb));
    expect(replayCommitted.divergences).toEqual([]);

    const branchEvents = JSON.parse(JSON.stringify(sb.history().slice(postSeedHistoryIndex)));
    const branch = await fork(baseState);
    apply(branch, branchEvents, { firestore: MULTI_WRITE_RULES });
    expect(snapshotDocuments(branch.sandbox)).toEqual(snapshotDocuments(sb));

    // 2. Rolled-back multi-write batch (gate denied) exercises uncommitted sequential projection in deriveRulesTestCases / verifyFixture
    const rolledBackBatch = writeBatch(db);
    rolledBackBatch.set(doc(db, 'items', 'createUpdate'), {
      owner: 'u1',
      count: 1,
      tags: ['a'],
      temp: 'drop-me',
    });
    rolledBackBatch.update(doc(db, 'items', 'createUpdate'), {
      count: increment(2),
      tags: arrayUnion('b'),
      temp: deleteField(),
    });
    rolledBackBatch.set(doc(db, 'items', 'gate'), { allowGate: false });
    await expect(rolledBackBatch.commit()).rejects.toThrow();

    const fixture = parseVerifyFixture(
      JSON.parse(
        JSON.stringify(
          buildVerifyFixture({
            sandbox: sb,
            firestoreRules: MULTI_WRITE_RULES,
          }),
        ),
      ),
    );
    const derived = deriveRulesTestCases(fixture);
    const createUpdateCases = derived.testCases.filter((tc) => tc.path === 'items/createUpdate');
    expect(createUpdateCases).toHaveLength(4);
    for (const tc of createUpdateCases) {
      expect(tc.expectation).toBe('ALLOW');
      expect(tc.data).toEqual({
        owner: 'u1',
        count: 3,
        tags: ['a', 'b'],
      });
    }

    const sameVerify = await verifyFixture(fixture, {
      rules: { firestore: MULTI_WRITE_RULES },
    });
    expect(sameVerify.services.firestore?.divergences).toEqual([]);
    expect(sameVerify.ok).toBe(true);

    const tightenedVerify = await verifyFixture(fixture, {
      rules: { firestore: TIGHTENED_COUNT_RULES },
    });
    expect(tightenedVerify.ok).toBe(false);
    expect(tightenedVerify.services.firestore?.divergences.some((d) => d.kind === 'now-denied')).toBe(
      true,
    );
  });

  it('separates structural write-preparation errors from genuine Security Rules denials across operation records, deriveRulesTestCases, and verifyFixture', async () => {
    const STRICT_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow read, create, delete: if request.auth != null;',
      "      allow update: if request.auth != null && request.resource.data.role == 'member';",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const PERMISSIVE_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /{document=**} {',
      '      allow read, write: if true;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const sbStructuralOnly = initializeSandbox();
    setRules(sbStructuralOnly, STRICT_RULES);
    seedDocuments(sbStructuralOnly, {
      'items/a': { role: 'member', count: 1 },
      'items/b': { role: 'member', count: 2 },
    });
    const dbStructural = getFirestore(sbStructuralOnly.withAuth({ uid: 'u1', token: {} }));

    // Structural batch prepare error: delete + update on the same document in one writeBatch
    const invalidBatch = writeBatch(dbStructural);
    invalidBatch.delete(doc(dbStructural, 'items', 'a'));
    invalidBatch.update(doc(dbStructural, 'items', 'a'), { role: 'member', count: 5 });
    await expect(invalidBatch.commit()).rejects.toMatchObject({ code: 'invalid-argument' });

    // Structural transaction prepare error: delete + update on the same document in one runTransaction
    await expect(
      runTransaction(dbStructural, async (tx) => {
        tx.delete(doc(dbStructural, 'items', 'b'));
        tx.update(doc(dbStructural, 'items', 'b'), { role: 'member', count: 9 });
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    const structuralRecords = sbStructuralOnly
      .history()
      .map(toOperationRecord)
      .filter((rec): rec is NonNullable<typeof rec> => rec !== null);
    expect(structuralRecords).toHaveLength(2);
    for (const rec of structuralRecords) {
      expect(rec.rules).toEqual({ kind: 'not-evaluated', reason: 'runtime-error' });
    }

    const structuralFixture = parseVerifyFixture(
      JSON.parse(
        JSON.stringify(
          buildVerifyFixture({
            sandbox: sbStructuralOnly,
            firestoreRules: STRICT_RULES,
          }),
        ),
      ),
    );
    expect(deriveRulesTestCases(structuralFixture).testCases).toEqual([]);

    const structuralUnderPermissive = await verifyFixture(structuralFixture, {
      rules: { firestore: PERMISSIVE_RULES },
    });
    expect(structuralUnderPermissive.services.firestore?.divergences).toEqual([]);
    expect(structuralUnderPermissive.ok).toBe(true);

    // Mixed fixture: add a genuine rules denial alongside structural prepare errors
    const dbMixed = getFirestore(sbStructuralOnly.withAuth({ uid: 'u1', token: {} }));
    await expect(
      updateDoc(doc(dbMixed, 'items', 'a'), { role: 'escalated-admin' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    const mixedFixture = parseVerifyFixture(
      JSON.parse(
        JSON.stringify(
          buildVerifyFixture({
            sandbox: sbStructuralOnly,
            firestoreRules: STRICT_RULES,
          }),
        ),
      ),
    );
    const mixedCases = deriveRulesTestCases(mixedFixture).testCases;
    expect(mixedCases).toHaveLength(1);
    expect(mixedCases[0]).toMatchObject({
      method: 'update',
      path: 'items/a',
      expectation: 'DENY',
    });

    const mixedSame = await verifyFixture(mixedFixture, {
      rules: { firestore: STRICT_RULES },
    });
    expect(mixedSame.ok).toBe(true);

    const mixedPermissive = await verifyFixture(mixedFixture, {
      rules: { firestore: PERMISSIVE_RULES },
    });
    expect(mixedPermissive.ok).toBe(false);
    expect(mixedPermissive.services.firestore?.divergences).toHaveLength(1);
    expect(mixedPermissive.services.firestore?.divergences[0]).toMatchObject({
      kind: 'now-allowed',
      method: 'update',
      path: 'items/a',
    });
  });

  it('verifies Storage-only fixtures backed by seeded Firestore documents for firestore.get() and firestore.exists() without requiring firestore.rules', async () => {
    const STORAGE_CROSS_SERVICE_RULES = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /orgs/{orgId}/{fileName} {',
      '      allow read, write: if request.auth != null',
      '        && firestore.exists(/databases/(default)/documents/orgs/$(orgId))',
      "        && firestore.get(/databases/(default)/documents/orgs/$(orgId)).data.owner == request.auth.uid;",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const TIGHTENED_STORAGE_RULES = STORAGE_CROSS_SERVICE_RULES.replace(
      '.data.owner == request.auth.uid',
      ".data.owner == 'nobody'",
    );

    const sb = initializeSandbox();
    seedDocuments(sb, {
      'orgs/o1': { owner: 'u1' },
      'orgs/o2': { owner: 'u2' },
    });

    const dbName = uniqueStorageDb('cross-service');
    const storageU1 = getStorageSandbox(sb.withAuth({ uid: 'u1', token: {} }), {
      dbName,
      rules: STORAGE_CROSS_SERVICE_RULES,
    });

    await uploadString(storageRef(storageU1, 'orgs/o1/report.txt'), 'quarterly-summary');
    const downloaded = await getBytes(storageRef(storageU1, 'orgs/o1/report.txt'));
    expect(new TextDecoder().decode(downloaded)).toBe('quarterly-summary');
    await expect(
      uploadString(storageRef(storageU1, 'orgs/o2/forbidden.txt'), 'blocked'),
    ).rejects.toMatchObject({ code: 'storage/unauthorized' });

    const fixture = parseVerifyFixture(
      JSON.parse(
        JSON.stringify(
          buildVerifyFixture({
            sandbox: sb,
            storageRules: STORAGE_CROSS_SERVICE_RULES,
          }),
        ),
      ),
    );

    // Seeded Firestore state is preserved on the fixture while only Storage is marked verifiable
    expect(fixture.services.firestore?.state.documents).toEqual({
      'orgs/o1': { owner: 'u1' },
      'orgs/o2': { owner: 'u2' },
    });
    expect(fixtureVerifiableServices(fixture)).toEqual(['storage']);

    // Verify succeeds with ONLY Storage rules supplied
    const sameVerify = await verifyFixture(fixture, {
      rules: { storage: STORAGE_CROSS_SERVICE_RULES },
    });
    expect(sameVerify.ok).toBe(true);
    expect(sameVerify.services.firestore).toBeUndefined();
    expect(sameVerify.services.storage?.divergences).toEqual([]);

    // Tightening Storage cross-service condition surfaces now-denied divergence
    const tightenedVerify = await verifyFixture(fixture, {
      rules: { storage: TIGHTENED_STORAGE_RULES },
    });
    expect(tightenedVerify.ok).toBe(false);
    expect(tightenedVerify.services.storage?.divergences.some((d) => d.kind === 'now-denied')).toBe(
      true,
    );
  });

  it('distinguishes map.get() / resource.data.get() method calls, comments, and strings from document lookups across plain and 2+modules rules', async () => {
    const MAP_GET_NON_LOOKUP_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    // get(/databases/$(database)/documents/orgs/o1)',
      '    /* exists(/databases/$(database)/documents/orgs/o1) */',
      '    match /items/{id} {',
      '      allow create, update: if request.auth != null',
      "        && request.resource.data.get('kind', 'none') != 'get(/databases/(default)/documents/orgs/o1)'",
      "        && request.resource.data.meta.get('tier', 'free') == 'pro';",
      '      allow get: if request.auth != null',
      "        && resource.data.get('owner', '') == request.auth.uid;",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const REAL_GET_AFTER_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow get, create, update: if request.auth != null',
      '        && existsAfter(/databases/$(database)/documents/items/$(id));',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const sb = initializeSandbox();
    setRules(sb, MAP_GET_NON_LOOKUP_RULES);
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    await setDoc(doc(db, 'items', 'i1'), {
      owner: 'u1',
      kind: 'item',
      meta: { tier: 'pro' },
    });
    await getDoc(doc(db, 'items', 'i1'));

    const rawFixture = JSON.parse(
      JSON.stringify(
        buildVerifyFixture({
          sandbox: sb,
          firestoreRules: MAP_GET_NON_LOOKUP_RULES,
        }),
      ),
    );
    // Strip rulesEvidence (simulating aged/evicted capture history) so deriveRulesTestCases uses static rules lookup classification
    for (const ev of rawFixture.events) {
      delete ev.rulesEvidence;
      ev.rulesEvidenceExpired = true;
    }
    const fixture = parseVerifyFixture(rawFixture);

    const nonLookupDerived = deriveRulesTestCases(fixture);
    expect(nonLookupDerived.ok).toBe(true);
    expect(nonLookupDerived.unsupportedEvents).toEqual([]);
    expect(nonLookupDerived.testCases).toHaveLength(2);

    const lookupFixture = parseVerifyFixture({
      ...rawFixture,
      services: {
        ...rawFixture.services,
        firestore: {
          ...rawFixture.services.firestore,
          rules: { format: 'firestore.rules', source: REAL_GET_AFTER_RULES },
        },
      },
    });
    const lookupDerived = deriveRulesTestCases(lookupFixture);
    expect(lookupDerived.ok).toBe(false);
    expect(lookupDerived.testCases).toEqual([]);
    expect(lookupDerived.unsupportedEvents).toHaveLength(2);

    const verified = await verifyFixture(fixture, {
      rules: { firestore: MAP_GET_NON_LOOKUP_RULES },
    });
    expect(verified.ok).toBe(true);
    expect(verified.services.firestore?.divergences).toEqual([]);
  });
});
