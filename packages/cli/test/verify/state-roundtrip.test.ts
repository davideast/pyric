import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  apply,
  applyFullState,
  captureFullState,
  createMemoryBackend,
  fork,
  getClock,
  initializeSandbox,
  replay,
  toOperationRecord,
} from 'pyric/sandbox';
import {
  decodeSnapshotMap,
  encodeSnapshotMap,
} from 'pyric/sandbox/internal';
import { encodeDocValue } from 'pyric/firestore/internal/value-codec';
import {
  arrayUnion,
  Bytes,
  deleteField,
  doc,
  type DocumentReference,
  GeoPoint,
  getDoc,
  getFirestore,
  increment,
  refEqual,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  VectorValue,
  writeBatch,
} from 'pyric/firestore';
import { firestoreRules } from 'pyric/rules';
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
  useHostedRulesTester,
  verifyFixture,
} from '../../src/verify/index.js';
import { SimulateFirestoreRulesHandler, buildApiTestCase } from 'pyric/rules/internal';

let nextStorageSeq = 1;
function uniqueStorageDb(prefix: string): string {
  return `state-roundtrip-${prefix}:${nextStorageSeq++}`;
}

function collectOwnSymbolsDeep(value: unknown, seen = new WeakSet<object>()): symbol[] {
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const found = [...Object.getOwnPropertySymbols(value)];
  if (Array.isArray(value)) {
    for (const item of value) {
      found.push(...collectOwnSymbolsDeep(item, seen));
    }
    return found;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    for (const key of Object.keys(value)) {
      found.push(...collectOwnSymbolsDeep((value as Record<string, unknown>)[key], seen));
    }
  }
  return found;
}

describe('state-roundtrip standing coverage for replay and verifyFixture', () => {
  it('round-trips DocumentReference values with named databaseId and default database across codecs, persistence, getDoc readback, deriveRulesTestCases, replay, and verifyFixture', async () => {
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

    const persistKey = `named-ref-persist-${nextStorageSeq++}`;
    const sb = initializeSandbox();
    await sb.enablePersistence({
      key: persistKey,
      backend: 'indexedDB',
    });
    setRules(sb, NAMED_REF_RULES);
    const authed = sb.withAuth({ uid: 'u1', token: {} });
    const defaultDb = getFirestore(authed);
    const tenantDb = getFirestore(authed, 'tenant-db');
    const analyticsDb = getFirestore(authed, 'analytics-db');

    const tenantRef = doc(tenantDb, 'orgs', 'o1');
    const defaultRef = doc(defaultDb, 'users', 'u1');
    const analyticsRef = doc(analyticsDb, 'docs', 'd1');
    const altAnalyticsRef = doc(analyticsDb, 'docs', 'd1');

    // Single write + update + read + client getDoc() readback round-trip into setDoc()
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
    await setDoc(doc(defaultDb, 'items', 'copiedFromReadback'), singleSnap.data()!);

    // Atomic batch write + Transaction write with named-DB references
    const batch = writeBatch(defaultDb);
    batch.set(doc(defaultDb, 'items', 'batched'), {
      tenantRef,
      defaultRef,
      nested: { analyticsRef },
    });
    await batch.commit();

    await runTransaction(defaultDb, async (tx) => {
      tx.set(doc(defaultDb, 'items', 'transacted'), {
        tenantRef,
        defaultRef,
        nested: { analyticsRef },
      });
    });

    await sb.flush();

    // 1. Persistence flush + restore onto a fresh sandbox preserves named databaseId
    const sbRestoredPersist = initializeSandbox();
    await sbRestoredPersist.enablePersistence({
      key: persistKey,
      backend: 'indexedDB',
    });
    setRules(sbRestoredPersist, NAMED_REF_RULES);
    const restoredPersistSnap = await getDoc(
      doc(getFirestore(sbRestoredPersist.withAuth({ uid: 'u1', token: {} })), 'items', 'single'),
    );
    expect(restoredPersistSnap.exists()).toBe(true);
    sbRestoredPersist.dispose();

    // 2. decodeSnapshotMap ('sdk' mode) forwards databaseId to ReferenceDecoder.create
    const encodedMap = JSON.parse(
      JSON.stringify(
        encodeSnapshotMap({
          tenantRef,
          defaultRef,
          nested: { analyticsRef },
        }),
      ),
    );
    const decodedRefs: Array<{ path: string; databaseId?: string }> = [];
    decodeSnapshotMap(encodedMap, {
      create: (path, databaseId) => {
        decodedRefs.push({ path, databaseId });
        return { path, databaseId };
      },
    });
    expect(decodedRefs).toEqual([
      { path: 'orgs/o1', databaseId: 'tenant-db' },
      { path: 'users/u1', databaseId: undefined },
      { path: 'docs/d1', databaseId: 'analytics-db' },
    ]);

    // 3. JSON-serialized replay() preserves named databaseId without state drift
    const wireHistory = JSON.parse(JSON.stringify(sb.history()));
    const replayed = replay(wireHistory, NAMED_REF_RULES, {}, snapshotDocuments(sb));
    expect(replayed.divergences).toEqual([]);

    // 4. captureFullState -> JSON -> applyFullState preserves named databaseId for subsequent reads
    const capturedFull = JSON.parse(JSON.stringify(await captureFullState(sb)));
    const restoredFull = initializeSandbox();
    await applyFullState(restoredFull, capturedFull);
    const restoredSnap = await getDoc(
      doc(getFirestore(restoredFull.withAuth({ uid: 'u1', token: {} })), 'items', 'single'),
    );
    expect(restoredSnap.exists()).toBe(true);

    // 5. buildVerifyFixture -> JSON -> parseVerifyFixture -> deriveRulesTestCases + public simulate() + wire-values + verifyFixture
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
    expect(derived.testCases.length).toBeGreaterThanOrEqual(5);

    const publicSim = firestoreRules(NAMED_REF_RULES).simulate(derived.testCases);
    expect(publicSim.failed).toBe(0);
    expect(publicSim.passed).toBe(derived.testCases.length);

    const firstWriteCase = derived.testCases.find((tc) => tc.path === 'items/single' && tc.data !== undefined)!;
    const wireCase = buildApiTestCase(firstWriteCase);
    const wireDoc = wireCase.request.resource!.data;
    expect(wireDoc.tenantRef).toBe('/databases/tenant-db/documents/orgs/o1');
    expect(wireDoc.defaultRef).toBe('/databases/(default)/documents/users/u1');
    expect((wireDoc.nested as Record<string, unknown>).analyticsRef).toBe(
      '/databases/analytics-db/documents/docs/d1',
    );

    let hostedCasesCount = 0;
    const restoreHosted = useHostedRulesTester(() => async (_scope, rulesSource, cases) => {
      hostedCasesCount = cases.length;
      for (const tc of cases) {
        buildApiTestCase(tc);
      }
      return new SimulateFirestoreRulesHandler().simulate(rulesSource, cases);
    });
    try {
      const hostedVerify = await verifyFixture(fixture, {
        engines: ['rulesTestApi'],
        rules: { firestore: NAMED_REF_RULES },
        rulesTestApi: {
          scope: {
            projectId: 'demo-test',
            getAccessToken: async () => 'token',
          },
        },
      });
      expect(hostedVerify.ok).toBe(true);
      expect(hostedCasesCount).toBe(derived.testCases.length);
    } finally {
      restoreHosted();
    }

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

  it('round-trips arbitrary user maps shaped like pyric/map/1.0 envelopes alongside real wrappers, float -0 / >=2^53, JSON/structuredClone boundaries, and zero public symbol leaks', async () => {
    const ENVELOPE_MAP_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/top {',
      '      allow create, update: if request.auth != null',
      "        && request.resource.data['type'] == 'pyric/map/1.0'",
      '        && request.resource.data.fields.count == 7',
      '        && request.resource.data.fields.ratio is float',
      '        && request.resource.data.fields.hugeIntFloat is float;',
      '      allow get: if request.auth != null',
      "        && resource.data['type'] == 'pyric/map/1.0'",
      '        && resource.data.fields.count == 7',
      '        && resource.data.fields.ratio is float',
      '        && resource.data.fields.hugeIntFloat is float;',
      '    }',
      '    match /items/seeded {',
      '      allow get: if request.auth != null',
      "        && resource.data['type'] == 'pyric/map/1.0'",
      "        && resource.data.fields.origin == 'seed'",
      '        && resource.data.fakeRef is map;',
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
      '        && request.resource.data.wrapped.fields.ratio is float',
      "        && request.resource.data.wrapped.fields.inner['type'] == 'pyric/map/1.0'",
      "        && request.resource.data.wrapped.fields.inner.fields.deep == 'yes'",
      "        && request.resource.data.list[0]['type'] == 'pyric/map/1.0'",
      "        && request.resource.data.sentinelLookalike['__type'] == 'serverTimestamp'",
      "        && request.resource.data.tsLookalike['type'] == 'firestore/timestamp/1.0'",
      '        && request.resource.data.fakeTs is map',
      '        && request.resource.data.fakeRef is map',
      '        && request.resource.data.fakeMethod is map',
      '        && request.resource.data.fakeClone is map',
      '        && request.resource.data.fakeVector is map',
      '        && request.resource.data.realTs is timestamp',
      '        && request.resource.data.realBytes is bytes',
      '        && request.resource.data.realGeo is latlng',
      '        && request.resource.data.namedRef == /databases/tenant-db/documents/orgs/o9;',
      '      allow get: if request.auth != null',
      "        && resource.data.wrapped['type'] == 'pyric/map/1.0'",
      '        && resource.data.wrapped.fields.ratio is float',
      "        && resource.data.wrapped.fields.inner['type'] == 'pyric/map/1.0'",
      "        && resource.data.list[0]['type'] == 'pyric/map/1.0'",
      "        && resource.data.sentinelLookalike['__type'] == 'serverTimestamp'",
      "        && resource.data.tsLookalike['type'] == 'firestore/timestamp/1.0'",
      '        && resource.data.fakeTs is map',
      '        && resource.data.fakeRef is map',
      '        && resource.data.fakeMethod is map',
      '        && resource.data.fakeClone is map',
      '        && resource.data.fakeVector is map',
      '        && resource.data.realTs is timestamp',
      '        && resource.data.namedRef == /databases/tenant-db/documents/orgs/o9;',
      '    }',
      '    match /items/deniedDotted {',
      '      allow update: if request.auth != null',
      "        && request.resource.data['type'] == 'pyric/map/1.0'",
      '        && request.resource.data.fields.allowed == true;',
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
        fakeRef: { id: 'o1', path: 'orgs/o1' },
      },
    });
    const baseBranchState = await captureFullState(sb);
    const postSeedIdx = sb.history().length;

    sb.admin.setDocument('items/adminDoc', {
      type: 'pyric/map/1.0',
      fields: { origin: 'admin' },
    });
    sb.admin.setDocument('items/deniedDotted', {
      fields: { allowed: false },
    });

    const authed = sb.withAuth({ uid: 'u1', token: {} });
    const db = getFirestore(authed);
    const tenantDb = getFirestore(authed, 'tenant-db');

    // Dedicated -0 and >=2^53 float typing check inside pyric/map/1.0 user map across setDoc, getDoc, structuredClone, captureFullState, and verifyFixture
    const negZeroSb = initializeSandbox();
    setRules(
      negZeroSb,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        '      allow create: if request.resource.data.wrapped.fields.v is float && request.resource.data.wrapped.fields.huge is float;',
        '      allow get: if resource.data.wrapped.fields.v is float && resource.data.wrapped.fields.huge is float;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    const negZeroDb = getFirestore(negZeroSb.withAuth({ uid: 'u1', token: {} }));
    await setDoc(doc(negZeroDb, 'items', 'neg0'), {
      wrapped: { type: 'pyric/map/1.0', fields: { v: -0, huge: 2 ** 53 } },
    });
    const negZeroSnap = await getDoc(doc(negZeroDb, 'items', 'neg0'));
    expect(negZeroSnap.exists()).toBe(true);
    expect(
      Object.is(
        ((negZeroSnap.data()?.wrapped as Record<string, unknown>).fields as Record<string, unknown>).v,
        -0,
      ),
    ).toBe(true);
    const negZeroFixture = parseVerifyFixture(
      JSON.parse(
        JSON.stringify(
          buildVerifyFixture({
            sandbox: negZeroSb,
            firestoreRules: [
              "rules_version = '2';",
              'service cloud.firestore {',
              '  match /databases/{database}/documents {',
              '    match /items/{id} {',
              '      allow create: if request.resource.data.wrapped.fields.v is float && request.resource.data.wrapped.fields.huge is float;',
              '      allow get: if resource.data.wrapped.fields.v is float && resource.data.wrapped.fields.huge is float;',
              '    }',
              '  }',
              '}',
            ].join('\n'),
          }),
        ),
      ),
    );
    const negZeroVerified = await verifyFixture(negZeroFixture, {
      rules: { firestore: negZeroFixture.services.firestore!.rules.source },
    });
    expect(negZeroVerified.ok).toBe(true);

    // Exact 2-key top-level pyric/map/1.0 user document with float and 2^53
    await setDoc(doc(db, 'items', 'top'), {
      type: 'pyric/map/1.0',
      fields: { count: 7, ratio: 1.5, hugeIntFloat: 2 ** 53 },
    });
    const topSnap = await getDoc(doc(db, 'items', 'top'));
    expect(topSnap.exists()).toBe(true);
    expect(topSnap.data()?.type).toBe('pyric/map/1.0');

    // Seeded and admin-written exact 2-key pyric/map/1.0 and { id, path } user map reads
    expect((await getDoc(doc(db, 'items', 'seeded'))).data()).toEqual({
      type: 'pyric/map/1.0',
      fields: { origin: 'seed' },
      fakeRef: { id: 'o1', path: 'orgs/o1' },
    });
    expect((await getDoc(doc(db, 'items', 'adminDoc'))).data()).toEqual({
      type: 'pyric/map/1.0',
      fields: { origin: 'admin' },
    });

    // Kitchen-sink document mixing all 6 colliding marker shapes and real SDK wrappers
    await setDoc(doc(db, 'items', 'kitchen'), {
      wrapped: {
        type: 'pyric/map/1.0',
        fields: {
          k: 1,
          ratio: 1.5,
          inner: { type: 'pyric/map/1.0', fields: { deep: 'yes' } },
        },
      },
      list: [{ type: 'pyric/map/1.0', fields: { idx: 0 } }],
      sentinelLookalike: { __type: 'serverTimestamp' },
      tsLookalike: { type: 'firestore/timestamp/1.0', seconds: 9, nanoseconds: 0 },
      fakeTs: { __type: 'timestamp', seconds: 9, nanos: 0 },
      fakeRef: { id: 'o1', path: 'orgs/o1', databaseId: 'analytics' },
      fakeMethod: { _methodName: 'serverTimestamp' },
      fakeClone: { typeName: 'timestamp', seconds: 100, nanos: 200 },
      fakeVector: { __type__: '__vector__', value: [3, 4] },
      realTs: new Timestamp(1_735_000_000, 500_000),
      realBytes: Bytes.fromUint8Array(new Uint8Array([4, 5, 6])),
      realGeo: new GeoPoint(37.5, -122.25),
      realVec: VectorValue.create([0.5, -0.25]),
      serverTs: serverTimestamp(),
      namedRef: doc(tenantDb, 'orgs', 'o9'),
    });
    const kitchenSnap = await getDoc(doc(db, 'items', 'kitchen'));
    expect(kitchenSnap.data()?.sentinelLookalike).toEqual({ __type: 'serverTimestamp' });
    expect(kitchenSnap.data()?.fakeRef).toEqual({
      id: 'o1',
      path: 'orgs/o1',
      databaseId: 'analytics',
    });
    expect(kitchenSnap.data()?.fakeMethod).toEqual({ _methodName: 'serverTimestamp' });
    expect(kitchenSnap.data()?.fakeClone).toEqual({
      typeName: 'timestamp',
      seconds: 100,
      nanos: 200,
    });
    expect(kitchenSnap.data()?.tsLookalike).toEqual({
      type: 'firestore/timestamp/1.0',
      seconds: 9,
      nanoseconds: 0,
    });

    // Denied single-segment update producing root colliding pyric/map/1.0 shape (exercises applyPathLeaf root stamping)
    await expect(
      updateDoc(doc(db, 'items', 'deniedDotted'), {
        type: 'pyric/map/1.0',
        'fields.allowed': false,
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    // 1. Public API cleanliness: unencoded AND symbol-free across snapshotDocuments, RequestEvent, WriteSandboxEvent, snapshot(), admin, and Worker admin.readState encodeDocValue
    expect(collectOwnSymbolsDeep(sb.history())).toEqual([]);
    expect(collectOwnSymbolsDeep(sb.snapshot())).toEqual([]);
    const snapDocs = snapshotDocuments(sb);
    expect(collectOwnSymbolsDeep(snapDocs)).toEqual([]);
    expect(snapDocs['items/top']).toEqual({
      type: 'pyric/map/1.0',
      fields: { count: 7, ratio: 1.5, hugeIntFloat: 2 ** 53 },
    });
    expect(snapDocs['items/kitchen']?.fakeRef).toEqual({
      id: 'o1',
      path: 'orgs/o1',
      databaseId: 'analytics',
    });
    expect(snapDocs['items/kitchen']?.sentinelLookalike).toEqual({ __type: 'serverTimestamp' });
    expect(snapDocs['items/kitchen']?.fakeMethod).toEqual({ _methodName: 'serverTimestamp' });
    expect(snapDocs['items/kitchen']?.fakeClone).toEqual({
      typeName: 'timestamp',
      seconds: 100,
      nanos: 200,
    });

    // Worker admin.readState path: encodeDocValue(snapshotDocuments(sb)) wraps once (never double-wraps)
    const encodedForWorker = JSON.parse(JSON.stringify(encodeDocValue(snapDocs))) as Record<
      string,
      Record<string, unknown>
    >;
    expect(encodedForWorker['items/kitchen']?.fakeRef).toEqual({
      type: 'pyric/map/1.0',
      fields: { id: 'o1', path: 'orgs/o1', databaseId: 'analytics' },
    });
    expect(encodedForWorker['items/kitchen']?.sentinelLookalike).toEqual({
      type: 'pyric/map/1.0',
      fields: { __type: 'serverTimestamp' },
    });

    // seedDocuments(sb2, snapshotDocuments(sb)) preserves all colliding maps as maps under live getDoc
    const reseededSb = initializeSandbox();
    setRules(reseededSb, ENVELOPE_MAP_RULES);
    seedDocuments(reseededSb, snapshotDocuments(sb));
    const reseededDb = getFirestore(reseededSb.withAuth({ uid: 'u1', token: {} }));
    const reseededKitchen = await getDoc(doc(reseededDb, 'items', 'kitchen'));
    expect(reseededKitchen.exists()).toBe(true);
    expect(reseededKitchen.data()?.fakeRef).toEqual({
      id: 'o1',
      path: 'orgs/o1',
      databaseId: 'analytics',
    });
    expect(reseededKitchen.data()?.sentinelLookalike).toEqual({ __type: 'serverTimestamp' });

    // RequestEvent & WriteSandboxEvent carry unencoded, symbol-free user maps (Studio Rules Debug inspector/rerun compatibility)
    const kitchenCreateReq = sb
      .history()
      .find(
        (e) =>
          e.kind === 'request' &&
          e.path === 'items/kitchen' &&
          (e.method === 'set' || e.method === 'create'),
      );
    expect(kitchenCreateReq?.kind === 'request' ? kitchenCreateReq.request?.resourceData?.fakeRef : undefined).toEqual({
      id: 'o1',
      path: 'orgs/o1',
      databaseId: 'analytics',
    });
    expect(
      kitchenCreateReq?.kind === 'request' ? kitchenCreateReq.resourceAfter?.data?.sentinelLookalike : undefined,
    ).toEqual({ __type: 'serverTimestamp' });
    const kitchenGetReq = sb
      .history()
      .find((e) => e.kind === 'request' && e.path === 'items/kitchen' && e.method === 'get');
    expect(
      kitchenGetReq?.kind === 'request' ? kitchenGetReq.resourceBefore?.data?.fakeRef : undefined,
    ).toEqual({ id: 'o1', path: 'orgs/o1', databaseId: 'analytics' });
    const kitchenWriteEv = sb
      .history()
      .find((e) => e.kind === 'write' && e.path === 'items/kitchen');
    expect(kitchenWriteEv?.kind === 'write' ? kitchenWriteEv.nextState?.fakeRef : undefined).toEqual({
      id: 'o1',
      path: 'orgs/o1',
      databaseId: 'analytics',
    });

    expect(collectOwnSymbolsDeep(sb.admin.getDocument('items/top'))).toEqual([]);
    expect(collectOwnSymbolsDeep(sb.admin.getDocument('items/kitchen'))).toEqual([]);
    expect(collectOwnSymbolsDeep(sb.admin.listDocuments('items'))).toEqual([]);

    // 2. snapshot() -> in-memory, structuredClone, AND JSON.parse(JSON.stringify(...)) -> loadSnapshot() pass live getDoc rules
    for (const clonedSnap of [
      sb.snapshot(),
      structuredClone(sb.snapshot()),
      JSON.parse(JSON.stringify(sb.snapshot())),
    ]) {
      const snapCopy = initializeSandbox();
      snapCopy.loadSnapshot(clonedSnap);
      const copyDb = getFirestore(snapCopy.withAuth({ uid: 'u1', token: {} }));
      const copyKitchen = await getDoc(doc(copyDb, 'items', 'kitchen'));
      expect(copyKitchen.exists()).toBe(true);
      expect(copyKitchen.data()?.sentinelLookalike).toEqual({ __type: 'serverTimestamp' });
      expect(copyKitchen.data()?.fakeTs).toEqual({ __type: 'timestamp', seconds: 9, nanos: 0 });
      expect(copyKitchen.data()?.fakeRef).toEqual({
        id: 'o1',
        path: 'orgs/o1',
        databaseId: 'analytics',
      });
      expect(copyKitchen.data()?.fakeMethod).toEqual({ _methodName: 'serverTimestamp' });
      expect(copyKitchen.data()?.fakeClone).toEqual({
        typeName: 'timestamp',
        seconds: 100,
        nanos: 200,
      });
      expect(copyKitchen.data()?.tsLookalike).toEqual({
        type: 'firestore/timestamp/1.0',
        seconds: 9,
        nanoseconds: 0,
      });
      expect((copyKitchen.data()?.wrapped as Record<string, unknown>).type).toBe('pyric/map/1.0');
      expect((copyKitchen.data()?.realTs as Timestamp).seconds).toBe(1_735_000_000);
      const copyTenantDb = getFirestore(snapCopy.withAuth({ uid: 'u1', token: {} }), 'tenant-db');
      expect(
        refEqual(copyKitchen.data()?.namedRef as DocumentReference, doc(copyTenantDb, 'orgs', 'o9')),
      ).toBe(true);
      expect(
        refEqual(copyKitchen.data()?.namedRef as DocumentReference, doc(copyDb, 'orgs', 'o9')),
      ).toBe(false);
      const copyTop = await getDoc(doc(copyDb, 'items', 'top'));
      expect(copyTop.data()?.type).toBe('pyric/map/1.0');
    }

    // 2b. captureFullState -> JSON -> applyFullState AND enablePersistence flush/restore preserve all 6 colliding shapes under live getDoc
    const fullStateJson = JSON.parse(JSON.stringify(await captureFullState(sb)));
    const fullStateRestored = initializeSandbox();
    await applyFullState(fullStateRestored, fullStateJson);
    const fullStateDb = getFirestore(fullStateRestored.withAuth({ uid: 'u1', token: {} }));
    const fullStateKitchen = await getDoc(doc(fullStateDb, 'items', 'kitchen'));
    expect(fullStateKitchen.exists()).toBe(true);
    expect(fullStateKitchen.data()?.fakeRef).toEqual({
      id: 'o1',
      path: 'orgs/o1',
      databaseId: 'analytics',
    });

    const persistMem = createMemoryBackend();
    const persistSource = initializeSandbox();
    await persistSource.enablePersistence({ key: 'fsq8-persist', injectedBackend: persistMem });
    persistSource.loadSnapshot(sb.snapshot());
    await persistSource.flush();
    persistSource.dispose();

    const persistRestored = initializeSandbox();
    await persistRestored.enablePersistence({ key: 'fsq8-persist', injectedBackend: persistMem });
    setRules(persistRestored, ENVELOPE_MAP_RULES);
    const persistDb = getFirestore(persistRestored.withAuth({ uid: 'u1', token: {} }));
    const persistKitchen = await getDoc(doc(persistDb, 'items', 'kitchen'));
    expect(persistKitchen.exists()).toBe(true);
    expect(persistKitchen.data()?.fakeRef).toEqual({
      id: 'o1',
      path: 'orgs/o1',
      databaseId: 'analytics',
    });
    persistRestored.dispose();

    // 3. Canonical replay(history, rules, {}, sb.snapshot().firestore) returns divergences: [] across all colliding shapes
    const canonicalSb = initializeSandbox();
    setRules(canonicalSb, ENVELOPE_MAP_RULES);
    const canonicalAuthed = canonicalSb.withAuth({ uid: 'u1', token: {} });
    const canonicalDb = getFirestore(canonicalAuthed);
    const canonicalTenantDb = getFirestore(canonicalAuthed, 'tenant-db');
    await setDoc(doc(canonicalDb, 'items', 'top'), {
      type: 'pyric/map/1.0',
      fields: { count: 7, ratio: 1.5, hugeIntFloat: 2 ** 53 },
    });
    await setDoc(doc(canonicalDb, 'items', 'kitchen'), {
      wrapped: {
        type: 'pyric/map/1.0',
        fields: {
          k: 1,
          ratio: 1.5,
          inner: { type: 'pyric/map/1.0', fields: { deep: 'yes' } },
        },
      },
      list: [{ type: 'pyric/map/1.0', fields: { idx: 0 } }],
      sentinelLookalike: { __type: 'serverTimestamp' },
      tsLookalike: { type: 'firestore/timestamp/1.0', seconds: 9, nanoseconds: 0 },
      fakeTs: { __type: 'timestamp', seconds: 9, nanos: 0 },
      fakeRef: { id: 'o1', path: 'orgs/o1', databaseId: 'analytics' },
      fakeMethod: { _methodName: 'serverTimestamp' },
      fakeClone: { typeName: 'timestamp', seconds: 100, nanos: 200 },
      fakeVector: { __type__: '__vector__', value: [3, 4] },
      realTs: new Timestamp(1_735_000_000, 500_000),
      realBytes: Bytes.fromUint8Array(new Uint8Array([4, 5, 6])),
      realGeo: new GeoPoint(37.5, -122.25),
      realVec: VectorValue.create([0.5, -0.25]),
      serverTs: serverTimestamp(),
      namedRef: doc(canonicalTenantDb, 'orgs', 'o9'),
    });
    for (const candidateEvents of [
      canonicalSb.history(),
      structuredClone(canonicalSb.history()),
      JSON.parse(JSON.stringify(canonicalSb.history())),
    ]) {
      const canonicalRep = replay(
        candidateEvents,
        ENVELOPE_MAP_RULES,
        {},
        canonicalSb.snapshot().firestore,
      );
      expect(canonicalRep.divergences).toEqual([]);
      const repDb = getFirestore(canonicalRep.sandbox.withAuth({ uid: 'u1', token: {} }));
      setRules(canonicalRep.sandbox, ENVELOPE_MAP_RULES);
      const repKitchen = await getDoc(doc(repDb, 'items', 'kitchen'));
      expect(repKitchen.data()?.fakeRef).toEqual({
        id: 'o1',
        path: 'orgs/o1',
        databaseId: 'analytics',
      });
      expect(repKitchen.data()?.fakeMethod).toEqual({ _methodName: 'serverTimestamp' });
      expect(repKitchen.data()?.fakeClone).toEqual({
        typeName: 'timestamp',
        seconds: 100,
        nanos: 200,
      });
    }

    const expectedReplayDocs = snapshotDocuments(sb);
    delete expectedReplayDocs['items/seeded'];
    const denyAllRules = ENVELOPE_MAP_RULES.replaceAll('request.auth != null', 'false');
    const deniedReplay = replay(
      JSON.parse(JSON.stringify(sb.history())),
      denyAllRules,
      {},
      expectedReplayDocs,
    );
    expect(deniedReplay.divergences.length).toBeGreaterThan(0);
    expect(collectOwnSymbolsDeep(deniedReplay.divergences)).toEqual([]);

    // Branch apply() over JSON-serialized events
    const wireBranchEvents = JSON.parse(JSON.stringify(sb.history().slice(postSeedIdx)));
    const branch = await fork(baseBranchState);
    apply(branch, wireBranchEvents);
    expect(snapshotDocuments(branch.sandbox)).toEqual(snapshotDocuments(sb));

    // 4. buildVerifyFixture -> JSON -> parseVerifyFixture -> verifyFixture round-trips losslessly across all 6 colliding shapes (0 state-drift)
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

    const loosenedDottedRules = ENVELOPE_MAP_RULES.replace(
      'request.resource.data.fields.allowed == true',
      'request.resource.data.fields.allowed == false',
    );
    const loosenedVerify = await verifyFixture(wireFixture, {
      rules: { firestore: loosenedDottedRules },
    });
    expect(loosenedVerify.ok).toBe(false);
    expect(loosenedVerify.services.firestore?.divergences).toContainEqual(
      expect.objectContaining({
        kind: 'now-allowed',
        path: 'items/deniedDotted',
        method: 'update',
      }),
    );
  });

  it('projects same-path multi-write atomic batches (including committed delete->set and constructor/__proto__ keys on create) sequentially across replay, branch apply, deriveRulesTestCases, and verifyFixture', async () => {
    const MULTI_WRITE_RULES = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/createUpdate {',
      '      allow create, update: if request.auth != null',
      '        && request.resource.data.owner == request.auth.uid',
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
      '      allow read: if request.auth != null;',
      '      allow write: if request.auth != null',
      '        && request.resource.data.ownerId == request.auth.uid',
      '        && request.resource.data.reborn == true',
      "        && !('legacy' in request.resource.data);",
      '    }',
      '    match /items/protoCreate {',
      '      allow create, update: if request.auth != null',
      "        && request.resource.data['constructor'] == 'widget';",
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
    sb.admin.setDocument('items/deleteSet', { ownerId: 'u1', legacy: 'old' });
    const baseState = await captureFullState(sb);
    const postSeedHistoryIndex = sb.history().length;

    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

    // 1. Committed multi-write batch exercising create->update, set->merge->mergeFields, set->delete, delete->set (under allow write: request.resource.data.ownerId == uid), and batched create with constructor/__proto__ keys
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
    committedBatch.set(doc(db, 'items', 'deleteSet'), { ownerId: 'u1', reborn: true });

    const protoPayload: Record<string, unknown> = { constructor: 'widget' };
    Object.defineProperty(protoPayload, '__proto__', {
      value: 'safe',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    committedBatch.set(doc(db, 'items', 'protoCreate'), protoPayload);

    committedBatch.set(doc(db, 'items', 'gate'), { allowGate: true });
    await committedBatch.commit();

    // Replay over JSON wire history + Branch apply()
    const fullWireHistory = JSON.parse(JSON.stringify(sb.history()));
    const replayCommitted = replay(fullWireHistory, MULTI_WRITE_RULES, {}, snapshotDocuments(sb));
    expect(replayCommitted.divergences).toEqual([]);

    const branchEvents = JSON.parse(JSON.stringify(sb.history().slice(postSeedHistoryIndex)));
    const branch = await fork(baseState);
    apply(branch, branchEvents);
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
    const deleteSetDeleteCase = derived.testCases.find(
      (tc) => tc.path === 'items/deleteSet' && tc.method === 'delete',
    );
    expect(deleteSetDeleteCase?.data).toEqual({ ownerId: 'u1', reborn: true });

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

    const invalidBatch = writeBatch(dbStructural);
    invalidBatch.delete(doc(dbStructural, 'items', 'a'));
    invalidBatch.update(doc(dbStructural, 'items', 'a'), { role: 'member', count: 5 });
    await expect(invalidBatch.commit()).rejects.toMatchObject({ code: 'invalid-argument' });

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

  it('verifies Storage-only fixtures backed by seeded or empty Firestore stores for firestore.get() and firestore.exists() without requiring firestore.rules', async () => {
    const STORAGE_CROSS_SERVICE_RULES = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /orgs/{orgId}/{fileName} {',
      '      allow read, write: if request.auth != null',
      '        && firestore.exists(/databases/(default)/documents/orgs/$(orgId))',
      '        && firestore.get(/databases/(default)/documents/orgs/$(orgId)).data.owner == request.auth.uid;',
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

    // Also trigger a non-rules Firestore write-prep runtime error to verify fixtureVerifiableServices delegates to rulesDispositionFor
    const dbPrepErr = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const prepErrBatch = writeBatch(dbPrepErr);
    prepErrBatch.delete(doc(dbPrepErr, 'orgs', 'o1'));
    prepErrBatch.update(doc(dbPrepErr, 'orgs', 'o1'), { owner: 'u1' });
    await expect(prepErrBatch.commit()).rejects.toMatchObject({ code: 'invalid-argument' });

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

    expect(fixtureVerifiableServices(fixture)).toEqual(['storage']);

    const sameVerify = await verifyFixture(fixture, {
      rules: { storage: STORAGE_CROSS_SERVICE_RULES },
    });
    expect(sameVerify.ok).toBe(true);
    expect(sameVerify.services.firestore).toBeUndefined();
    expect(sameVerify.services.storage?.divergences).toEqual([]);

    const tightenedVerify = await verifyFixture(fixture, {
      rules: { storage: TIGHTENED_STORAGE_RULES },
    });
    expect(tightenedVerify.ok).toBe(false);
    expect(tightenedVerify.services.storage?.divergences.some((d) => d.kind === 'now-denied')).toBe(
      true,
    );

    // Empty Firestore store ({}): !firestore.exists(...) on missing doc evaluates true rather than throwing unsupported
    const EMPTY_FS_STORAGE_RULES = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      '      allow read, write: if request.auth != null',
      '        && !firestore.exists(/databases/(default)/documents/users/$(request.auth.uid));',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const sbEmpty = initializeSandbox();
    const storageEmpty = getStorageSandbox(sbEmpty.withAuth({ uid: 'u1', token: {} }), {
      dbName: uniqueStorageDb('empty-fs'),
      rules: EMPTY_FS_STORAGE_RULES,
    });
    await uploadString(storageRef(storageEmpty, 'items/a.txt'), 'allowed-when-unblocked');

    const emptyFixture = parseVerifyFixture(
      JSON.parse(
        JSON.stringify(
          buildVerifyFixture({
            sandbox: sbEmpty,
            storageRules: EMPTY_FS_STORAGE_RULES,
          }),
        ),
      ),
    );
    expect(emptyFixture.services.firestore).toBeUndefined();
    const emptyVerify = await verifyFixture(emptyFixture, {
      rules: { storage: EMPTY_FS_STORAGE_RULES },
    });
    expect(emptyVerify.ok).toBe(true);
    expect(emptyVerify.services.storage?.divergences).toEqual([]);
  });

  it('distinguishes map.get() / resource.data.get() method calls, comments, and strings from document lookups and fails closed on unresolved 2+modules imports', async () => {
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

    const UNRESOLVABLE_MODULAR_RULES = [
      "rules_version = '2+modules';",
      "import { canAccessOrg } from './org_helpers.rules';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow get, create, update: if canAccessOrg(id);',
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

    // Unresolvable 2+modules relative imports (and malformed module headers with top-level import) fail closed
    for (const modularSource of [
      UNRESOLVABLE_MODULAR_RULES,
      "import { canAccessOrg } from './org_helpers.rules';\nservice cloud.firestore { broken",
    ]) {
      const unresolvedModularFixture = parseVerifyFixture({
        ...rawFixture,
        services: {
          ...rawFixture.services,
          firestore: {
            ...rawFixture.services.firestore,
            rules: { format: 'firestore.rules', source: modularSource },
          },
        },
      });
      const unresolvedModularDerived = deriveRulesTestCases(unresolvedModularFixture);
      expect(unresolvedModularDerived.ok).toBe(false);
      expect(unresolvedModularDerived.testCases).toEqual([]);
      expect(unresolvedModularDerived.unsupportedEvents).toHaveLength(2);
    }

    const verified = await verifyFixture(fixture, {
      rules: { firestore: MAP_GET_NON_LOOKUP_RULES },
    });
    expect(verified.ok).toBe(true);
    expect(verified.services.firestore?.divergences).toEqual([]);
  });
});
