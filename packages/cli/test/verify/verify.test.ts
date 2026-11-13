import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  equalTo,
  get,
  onValue,
  getDatabase,
  orderByChild,
  query,
  ref,
  remove,
  runTransaction,
  set,
  update,
  sandbox as rtdbSandbox,
} from 'pyric/database';
import { defineRtdbRules, allow, deny } from 'pyric/rules';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore, getFirestore } from 'pyric/sandbox/admin-firestore';
import {
  Bytes as FsBytes,
  FieldPath as FsFieldPath,
  GeoPoint as FsGeoPoint,
  Timestamp as FsTimestamp,
  arrayRemove as fsArrayRemove,
  arrayUnion as fsArrayUnion,
  collection as fsCollection,
  deleteDoc as fsDeleteDoc,
  deleteField as fsDeleteField,
  doc as fsDoc,
  getDoc as fsGetDoc,
  getDocs as fsGetDocs,
  getFirestore as getClientFirestore,
  increment as fsIncrement,
  limit as fsLimit,
  onSnapshot as fsOnSnapshot,
  orderBy as fsOrderBy,
  query as fsQuery,
  runTransaction as fsRunTransaction,
  serverTimestamp as fsServerTimestamp,
  setDoc as fsSetDoc,
  updateDoc as fsUpdateDoc,
  vector as fsVector,
  where as fsWhere,
  writeBatch as fsWriteBatch,
} from 'pyric/firestore';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { setRules as setFirestoreRules, seedDocuments as seedFirestoreDocuments } from 'pyric/sandbox/firestore';
import { runDerivedCases } from '../../src/bridge/surface/assurance-cases.js';
import { getMetadata, getStorage, getStorageSandbox, ref as storageRef, updateMetadata, uploadBytes } from 'pyric/storage';
import { createAppForSandbox } from 'pyric/app/internal';
import { emitSandboxEvent, observedCallEvent } from 'pyric/sandbox/internal';
import {
  buildVerifyFixture,
  deriveRulesTestCases,
  fixtureVerifiableServices,
  parseVerifyFixture,
  restoreStorageRulesFromFixture,
  verifyFixture,
  VerifyInputError,
  type PyricVerifyFixture,
} from '../../src/verify/index.js';
import type { ProjectScope } from '../../src/credentials/core/types.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-verify-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

const ALLOW_ALL_RTDB = { rules: { '.read': true, '.write': true } };
const DENY_ALL_RTDB = { rules: { '.read': false, '.write': false } };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

const ALICE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} { allow read, write: if request.auth.uid == 'alice'; }
  }
}`;
const FIRESTORE_SETUP_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /setup/{id} {
      allow read, write: if false;
    }
    match /notes/{id} {
      allow read, write: if request.auth.uid == 'alice';
    }
  }
}`;

const MOCK_SCOPE: ProjectScope = {
  projectId: 'demo-project',
  resolveToken: async () => 'mock-token',
};

async function captureRtdbJourney(): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  const adminDb = getDatabase(sandbox);
  rtdbSandbox.setRules(adminDb, ALLOW_ALL_RTDB);
  rtdbSandbox.setData(adminDb, {
    '/counters/c1': 1,
    '/gone/x': true,
  });

  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  await set(ref(db, '/profiles/alice'), { name: 'Alice' });
  await update(ref(db, '/profiles/alice'), { active: true });
  await remove(ref(db, '/gone/x'));
  await runTransaction<number>(ref(db, '/counters/c1'), (current) => (current ?? 0) + 1, {
    applyLocally: false,
  });

  return buildVerifyFixture({
    sandbox,
    rtdbRules: ALLOW_ALL_RTDB,
    rtdbState: rtdbSandbox.snapshotState(adminDb),
  });
}

async function captureFirestoreJourney(): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  db.setRules(ALICE_RULES);
  await db.doc('notes/first').set({ title: 'first' });
  return buildVerifyFixture({
    sandbox,
    firestoreRules: ALICE_RULES,
  });
}

describe('verifyFixture', () => {
  it('parses service-shaped fixtures and rejects the old flat shape', () => {
    const good = buildVerifyFixture({
      sandbox: initializeSandbox(),
      rtdbRules: ALLOW_ALL_RTDB,
      rtdbState: {},
    });
    expect(parseVerifyFixture(good).schema).toBe('pyric.verify.fixture.v1');
    expect(() => parseVerifyFixture({ rules: '', events: [], state: {} })).toThrow(
      /fixture schema/,
    );
  });

  it('accepts an RtdbRulesDocument and replays set, update, remove, and transaction commits', async () => {
    const fixture = await captureRtdbJourney();
    const rules = defineRtdbRules({
      paths: {
        '/': { read: allow(), write: allow() },
      },
    });

    const result = await verifyFixture(fixture, {
      rules: { rtdb: rules },
    });

    expect(result.ok).toBe(true);
    expect(result.services.rtdb?.checkedEvents).toBe(4);
  });

  it('uses Firestore admin setup writes as replay context, not protected behavior', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    const adminDb = getAdminFirestore(sandbox);
    db.setRules(FIRESTORE_SETUP_RULES);

    await adminDb.doc('setup/seed').set({ enabled: true });
    await db.doc('notes/n1').set({ title: 'hello' });

    const fixture = buildVerifyFixture({
      sandbox,
      firestoreRules: FIRESTORE_SETUP_RULES,
    });
    const setupWrite = fixture.events.find(
      (event) => event.kind === 'write' && event.path === 'setup/seed',
    );

    expect(setupWrite?.detail?.admin).toBe(true);

    const result = await verifyFixture(fixture, {
      rules: { firestore: FIRESTORE_SETUP_RULES },
    });

    expect(result.ok).toBe(true);
    expect(result.services.firestore?.checkedEvents).toBe(1);
  });

  it('reports now-denied when RTDB candidate rules reject captured writes', async () => {
    const fixture = await captureRtdbJourney();
    const result = await verifyFixture(fixture, {
      rules: { rtdb: DENY_ALL_RTDB },
    });

    expect(result.ok).toBe(false);
    expect(result.services.rtdb?.divergences.some((d) => d.kind === 'now-denied')).toBe(true);
  });

  it('checks the default RTDB instance\'s writes against its rules, and names a named instance it has no rules for', async () => {
    const sandbox = initializeSandbox();
    const adminDb = getDatabase(sandbox);
    const shardUrl = 'https://shard-00.firebaseio.com';
    rtdbSandbox.setRules(adminDb, ALLOW_ALL_RTDB);
    rtdbSandbox.setRules(getDatabase(sandbox, shardUrl), ALLOW_ALL_RTDB);
    const alice = sandbox.withAuth({ uid: 'alice' });
    await set(ref(getDatabase(alice), '/profiles/alice'), { name: 'Alice' });
    await set(ref(getDatabase(alice, shardUrl), '/messages/m1'), { text: 'on the shard' });
    const fixture = buildVerifyFixture({
      sandbox,
      rtdbRules: ALLOW_ALL_RTDB,
      rtdbState: rtdbSandbox.snapshotState(adminDb),
    });

    const result = await verifyFixture(fixture, { rules: { rtdb: ALLOW_ALL_RTDB } });

    expect(result.services.rtdb?.divergences).toEqual([]);
    expect(result.services.rtdb?.checkedEvents).toBe(1);
    expect(result.services.rtdb?.skippedInstances).toEqual(['shard-00']);
  });

  it('reports state drift when replayed RTDB state differs from the fixture', async () => {
    const fixture = await captureRtdbJourney();
    const tampered = JSON.parse(JSON.stringify(fixture)) as PyricVerifyFixture;
    const tree = tampered.services.rtdb!.state.tree as {
      profiles: { alice: { name: string; active: boolean } };
    };
    tree.profiles.alice.name = 'Mallory';
    const result = await verifyFixture(tampered, {
      rules: { rtdb: ALLOW_ALL_RTDB },
    });

    expect(result.ok).toBe(false);
    expect(result.services.rtdb?.divergences.some((d) => d.kind === 'state-drift')).toBe(true);
  });

  describe('RTDB reads and denials', () => {
    const OWNER_ONLY = {
      rules: { profiles: { $uid: { '.read': 'auth.uid === $uid', '.write': 'auth.uid === $uid' } } },
    };

    /** A session where alice reads her own profile once and by listener, and is denied a write to bob's; as written to disk. */
    async function captureOwnerSession(): Promise<PyricVerifyFixture> {
      const sandbox = initializeSandbox();
      const adminDb = getDatabase(sandbox);
      rtdbSandbox.setRules(adminDb, OWNER_ONLY);
      rtdbSandbox.setData(adminDb, { '/profiles/alice': { name: 'Alice' }, '/profiles/bob': { name: 'Bob' } });
      const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
      await get(ref(db, 'profiles/alice'));
      const off = onValue(ref(db, 'profiles/alice'), () => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      off();
      await set(ref(db, 'profiles/bob/name'), 'Mallory').catch(() => {});
      const fixture = buildVerifyFixture({ sandbox, rtdbRules: OWNER_ONLY, rtdbState: rtdbSandbox.snapshotState(adminDb) });
      return JSON.parse(JSON.stringify(fixture)) as PyricVerifyFixture;
    }

    it('replays cleanly under the rules it was captured with', async () => {
      const result = await verifyFixture(await captureOwnerSession(), { rules: { rtdb: OWNER_ONLY } });
      expect(result.services.rtdb?.divergences).toEqual([]);
      expect(result.services.rtdb?.checkedEvents).toBe(3);
      expect(result.ok).toBe(true);
    });

    it('fails with now-allowed when the candidate rules open a write the session was denied', async () => {
      const result = await verifyFixture(await captureOwnerSession(), { rules: { rtdb: ALLOW_ALL_RTDB } });
      expect(result.ok).toBe(false);
      expect(result.services.rtdb?.divergences).toEqual([
        expect.objectContaining({ service: 'rtdb', kind: 'now-allowed', method: 'set', path: '/profiles/bob/name' }),
      ]);
    });

    it('fails with now-denied when the candidate rules stop allowing the session\'s get and listener', async () => {
      const writesOnly = { rules: { profiles: { $uid: { '.write': 'auth.uid === $uid' } } } };
      const result = await verifyFixture(await captureOwnerSession(), { rules: { rtdb: writesOnly } });
      expect(result.ok).toBe(false);
      expect(result.services.rtdb?.divergences).toEqual([
        expect.objectContaining({ kind: 'now-denied', method: 'get', path: '/profiles/alice' }),
        expect.objectContaining({ kind: 'now-denied', method: 'listen', path: '/profiles/alice' }),
      ]);
    });
  });

  it('compiles denying constraints documents through toJSON', async () => {
    const fixture = await captureRtdbJourney();
    const rules = defineRtdbRules({
      paths: {
        '/': { read: deny(), write: deny() },
      },
    });

    const result = await verifyFixture(fixture, {
      rules: { rtdb: rules },
    });

    expect(result.ok).toBe(false);
    expect(result.services.rtdb?.divergences.some((d) => d.kind === 'now-denied')).toBe(true);
  });

  it('derives Firestore Rules Test API cases from captured request events', async () => {
    const fixture = await captureFirestoreJourney();
    const result = deriveRulesTestCases(fixture);

    expect(result.ok).toBe(true);
    expect(result.testCases).toHaveLength(1);
    expect(result.testCases[0]).toMatchObject({
      expectation: 'ALLOW',
      method: 'create',
      path: 'notes/first',
      auth: { uid: 'alice' },
      data: { title: 'first' },
    });
  });

  it('preserves captured Firestore request.query in derived test cases', () => {
    const fixture: PyricVerifyFixture = {
      schema: 'pyric.verify.fixture.v1',
      events: [
        {
          kind: 'request',
          id: 'req-list',
          at: 1,
          evalMs: 0,
          method: 'list',
          path: 'notes',
          auth: { uid: 'alice' },
          result: 'allow',
          reasons: ['Simulated: ALLOW'],
          origin: 'user',
          detail: { query: { limit: 10, orderBy: 'createdAt' } },
        },
      ],
      services: {
        firestore: {
          rules: { format: 'firestore.rules', source: ALICE_RULES },
          state: { documents: {} },
        },
      },
    };

    const result = deriveRulesTestCases(fixture);

    expect(result.testCases[0].query).toEqual({ limit: 10, orderBy: 'createdAt' });
  });

  it('fails closed when a captured request needs exact rule-read mocks', () => {
    const fixture: PyricVerifyFixture = {
      schema: 'pyric.verify.fixture.v1',
      events: [
        {
          kind: 'request',
          id: 'req-read',
          at: 1,
          evalMs: 0,
          method: 'create',
          path: 'notes/first',
          auth: { uid: 'alice' },
          result: 'allow',
          reasons: ["Rule #0 (create) → ALLOW because get(/databases/$(database)/documents/users/alice)"],
          origin: 'user',
          request: { resourceData: { title: 'first' } },
          resourceBefore: { data: null, exists: false },
          resourceAfter: { data: { title: 'first' }, exists: true },
        },
      ],
      services: {
        firestore: {
          rules: { format: 'firestore.rules', source: ALICE_RULES },
          state: { documents: {} },
        },
      },
    };

    const result = deriveRulesTestCases(fixture);

    expect(result.ok).toBe(false);
    expect(result.unsupportedEvents[0]?.reason).toContain('exact rule-read mocks');
  });

  it('distinguishes map.get() method calls, comments, and strings from real document lookups in deriveRulesTestCases', async () => {
    const mapMethodRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Comment mentioning get(/databases/$(database)/documents/users/alice)
    /* Block comment mentioning existsAfter(/databases/$(database)/documents/users/alice) */
    match /items/{id} {
      allow create: if request.auth != null
        && request.resource.data.get('visibility', 'public') == 'public'
        && request.resource.data.get('note', '') != 'get(/databases/(default)/documents/x/y)';
      allow get: if request.auth != null
        && resource.data
          .get('visibility', 'public') == 'public';
    }
  }
}`;
    const sbMap = initializeSandbox();
    setFirestoreRules(sbMap, mapMethodRules);
    const clientMap = getClientFirestore(sbMap.withAuth({ uid: 'alice' }));
    await fsSetDoc(fsDoc(clientMap, 'items', 'i1'), { title: 'hello' });
    await fsGetDoc(fsDoc(clientMap, 'items', 'i1'));
    const fixtureMap = parseVerifyFixture(
      JSON.parse(JSON.stringify(buildVerifyFixture({ sandbox: sbMap, firestoreRules: mapMethodRules }))),
    );
    const derivedMap = deriveRulesTestCases(fixtureMap);
    expect(derivedMap.ok).toBe(true);
    expect(derivedMap.unsupportedEvents).toEqual([]);
    expect(derivedMap.testCases).toHaveLength(2);

    const helperLookupRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function orgDefaultVisibility() {
      return get(/databases/$(database)/documents/orgs/o1).data.defaultVisibility;
    }
    match /items/{id} {
      allow create: if request.auth != null
        && request.resource.data.get('visibility', orgDefaultVisibility()) == 'public';
    }
  }
}`;
    const sbLookup = initializeSandbox();
    setFirestoreRules(sbLookup, helperLookupRules);
    seedFirestoreDocuments(sbLookup, { 'orgs/o1': { defaultVisibility: 'public' } });
    const clientLookup = getClientFirestore(sbLookup.withAuth({ uid: 'alice' }));
    await fsSetDoc(fsDoc(clientLookup, 'items', 'i1'), { title: 'hello' });
    const fixtureLookup = parseVerifyFixture(
      JSON.parse(JSON.stringify(buildVerifyFixture({ sandbox: sbLookup, firestoreRules: helperLookupRules }))),
    );
    const derivedLookup = deriveRulesTestCases(fixtureLookup);
    expect(derivedLookup.ok).toBe(false);
    expect(derivedLookup.unsupportedEvents.length).toBeGreaterThan(0);
  });

  it('runs Firestore fixture verification through the hosted Rules Test API engine', async () => {
    const fixture = await captureFirestoreJourney();
    (global as any).fetch = async () =>
      new Response(JSON.stringify({ testResults: [{ state: 'SUCCESS' }] }), { status: 200 });

    const result = await verifyFixture(fixture, {
      engines: ['rulesTestApi'],
      rules: { firestore: ALICE_RULES },
      rulesTestApi: { scope: MOCK_SCOPE, expressionReportLevel: 'VISITED' },
    });

    expect(result.ok).toBe(true);
    expect(result.services.firestore?.engines?.rulesTestApi?.testCases).toBe(1);
  });

  it('sends a create of an existing document to the hosted engine without the existing resource (#1338)', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    db.setRules(ALICE_RULES);
    await db.doc('notes/n1').set({ title: 'first' });
    await db.doc('notes/n1').create({ title: 'again' }).catch(() => undefined);
    const fixture = buildVerifyFixture({ sandbox, firestoreRules: ALICE_RULES });

    const derived = deriveRulesTestCases(fixture);
    const creates = derived.testCases.filter((tc) => tc.method === 'create');
    expect(creates.length).toBeGreaterThan(0);
    for (const tc of creates) expect(tc.resource).toBeUndefined();

    let sentCases = 0;
    (global as any).fetch = async (_url: string, init: { body: string }) => {
      const cases = (JSON.parse(init.body) as { testSuite: { testCases: unknown[] } }).testSuite.testCases;
      sentCases = cases.length;
      return new Response(JSON.stringify({ testResults: cases.map(() => ({ state: 'SUCCESS' })) }), { status: 200 });
    };
    const result = await verifyFixture(fixture, {
      engines: ['rulesTestApi'],
      rules: { firestore: ALICE_RULES },
      rulesTestApi: { scope: MOCK_SCOPE },
    });

    expect(sentCases).toBe(derived.testCases.length);
    expect(result.services.firestore?.engines?.rulesTestApi?.checkedEvents).toBe(derived.testCases.length);
  });

  it('reports now-denied when hosted Rules Test API fails an allowed captured request', async () => {
    const fixture = await captureFirestoreJourney();
    (global as any).fetch = async () =>
      new Response(JSON.stringify({ testResults: [{ state: 'FAILURE', debugMessages: ['Denied'] }] }), { status: 200 });

    const result = await verifyFixture(fixture, {
      engines: ['rulesTestApi'],
      rules: { firestore: ALICE_RULES },
      rulesTestApi: { scope: MOCK_SCOPE },
    });

    expect(result.ok).toBe(false);
    expect(result.services.firestore?.divergences.some((d) => d.kind === 'now-denied')).toBe(true);
  });

  it('does not double count service checkedEvents when both engines run', async () => {
    const fixture = await captureFirestoreJourney();
    (global as any).fetch = async () =>
      new Response(JSON.stringify({ testResults: [{ state: 'SUCCESS' }] }), { status: 200 });

    const result = await verifyFixture(fixture, {
      engines: ['sandbox', 'rulesTestApi'],
      rules: { firestore: ALICE_RULES },
      rulesTestApi: { scope: MOCK_SCOPE },
    });

    expect(result.ok).toBe(true);
    expect(result.services.firestore?.checkedEvents).toBe(1);
    expect(result.services.firestore?.engines?.sandbox?.checkedEvents).toBe(1);
    expect(result.services.firestore?.engines?.rulesTestApi?.checkedEvents).toBe(1);
  });

  it('rejects RTDB verification when candidate rules would not deploy (CON-8)', async () => {
    const fixture = await captureRtdbJourney();

    await expect(
      verifyFixture(fixture, {
        rules: { rtdb: { rules: { '.read': true, '.valdiate': false } } },
      }),
    ).rejects.toThrow(
      new VerifyInputError(
        "candidate RTDB rules would not deploy. Realtime Database rules did not compile. /: Expected '{'.",
      ),
    );
  });

  it('rejects RTDB verification through the Rules Test API engine', async () => {
    const fixture = await captureRtdbJourney();

    await expect(
      verifyFixture(fixture, {
        engines: ['rulesTestApi'],
        rules: { rtdb: ALLOW_ALL_RTDB },
        rulesTestApi: { scope: MOCK_SCOPE },
      }),
    ).rejects.toThrow(VerifyInputError);
  });
});

// ─── RTDB case kinds: multi-path update, scalar write, query read ───────
//
// A captured journey replays each of these against candidate rules, so a
// rule change that denies one of them is reported as a divergence.
describe('verifyFixture RTDB case kinds', () => {
  const CAPTURE_RULES = {
    rules: {
      '.read': true,
      '.write': true,
      items: { '.indexOn': ['owner'] },
    },
  };

  async function captureCaseKinds(): Promise<PyricVerifyFixture> {
    const sandbox = initializeSandbox();
    const adminDb = getDatabase(sandbox);
    rtdbSandbox.setRules(adminDb, CAPTURE_RULES);
    rtdbSandbox.setData(adminDb, { '/items/a': { owner: 'alice' } });
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    await update(ref(db), { scores: 4, totals: 5 });
    await set(ref(db, 'flag'), true);
    await get(query(ref(db, 'items'), orderByChild('owner'), equalTo('alice')));
    return buildVerifyFixture({
      sandbox,
      rtdbRules: CAPTURE_RULES,
      rtdbState: rtdbSandbox.snapshotState(adminDb),
    });
  }

  const candidate = (rules: Record<string, unknown>) => ({
    rules: { '.read': false, '.write': true, items: { '.indexOn': ['owner'] }, ...rules },
  });
  const diverged = async (rules: Record<string, unknown>) => {
    const result = await verifyFixture(await captureCaseKinds(), { rules: { rtdb: candidate(rules) } });
    // A write the candidate rules refuse also leaves the replayed state short
    // of the captured one, so the denial is the divergence under test.
    return (result.services.rtdb?.divergences ?? []).filter((d) => d.kind === 'now-denied');
  };

  it('accepts candidate rules that allow every captured kind', async () => {
    const result = await verifyFixture(await captureCaseKinds(), {
      rules: {
        rtdb: candidate({
          items: {
            '.indexOn': ['owner'],
            '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid",
          },
        }),
      },
    });
    expect(result.services.rtdb?.divergences).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('reports a multi-path update a candidate rule now denies', async () => {
    const found = await diverged({
      totals: { '.validate': "newData.val() == newData.parent().child('scores').val() + 2" },
      items: { '.indexOn': ['owner'], '.read': true },
    });
    expect(found).toEqual([expect.objectContaining({ kind: 'now-denied', method: 'update' })]);
  });

  it('reports a scalar write a candidate rule now denies', async () => {
    const found = await diverged({
      flag: { '.validate': 'newData.val() == false' },
      items: { '.indexOn': ['owner'], '.read': true },
    });
    expect(found).toEqual([expect.objectContaining({ kind: 'now-denied', method: 'set' })]);
  });

  it('reports a query read a candidate rule now denies', async () => {
    const found = await diverged({
      items: {
        '.indexOn': ['owner'],
        '.read': "query.orderByChild == 'owner' && query.equalTo == 'bob'",
      },
    });
    expect(found).toEqual([expect.objectContaining({ kind: 'now-denied', method: 'get', path: '/items' })]);
  });

  it('counts the query read as a checked event', async () => {
    const result = await verifyFixture(await captureCaseKinds(), {
      rules: { rtdb: candidate({ items: { '.indexOn': ['owner'], '.read': true } }) },
    });
    expect(result.services.rtdb?.checkedEvents).toBe(3);
  });
});

// ─── Live calls: production's answer replayed against the local rules ───
describe('verifyFixture live Firestore calls', () => {
  const ADMIN_READS = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /rooms/{id} { allow read: if request.auth.token.admin == true; }
  }
}`;
  const OWNER_WRITES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /rooms/{id} { allow create, update: if request.resource.data.owner == request.auth.uid; }
  }
}`;
  const NO_ONE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{p=**} { allow read, write: if false; }
  }
}`;

  type ObservedValues = NonNullable<PyricVerifyFixture['observedCalls']>[string];

  /** A capture holding one live call production answered, with the values it carried. */
  function liveCapture(call: Parameters<typeof observedCallEvent>[0], values: ObservedValues, rules: string): PyricVerifyFixture {
    const sandbox = initializeSandbox();
    emitSandboxEvent(sandbox, observedCallEvent(call), { caller: { kind: 'node' } });
    const id = sandbox.history().at(-1)!.id;
    return buildVerifyFixture({ sandbox, firestoreRules: rules, observedCalls: { [id]: values } });
  }

  const read = (outcome: { status: 'ok' } | { status: 'error'; code: string }) => ({
    service: 'firestore' as const, method: 'getDoc', path: 'rooms/r1', at: 1, outcome, account: { uid: 'alice' },
  });
  const write = { service: 'firestore' as const, method: 'setDoc', path: 'rooms/r1', at: 1, outcome: { status: 'ok' as const }, account: { uid: 'alice' } };

  it('reports no divergence when the local rules still answer as production did', async () => {
    const fixture = liveCapture(read({ status: 'ok' }), { claims: { admin: true } }, ADMIN_READS);
    const result = await verifyFixture(fixture, { rules: { firestore: ADMIN_READS } });
    expect(result.services.firestore?.divergences).toEqual([]);
    expect(result.services.firestore?.checkedEvents).toBe(1);
  });

  it('reports now-denied for a live read production allowed and the local rules deny', async () => {
    const fixture = liveCapture(read({ status: 'ok' }), { claims: { admin: true } }, ADMIN_READS);
    const result = await verifyFixture(fixture, { rules: { firestore: NO_ONE } });
    expect(result.ok).toBe(false);
    expect(result.services.firestore?.divergences).toMatchObject([{ service: 'firestore', kind: 'now-denied', path: 'rooms/r1', method: 'get' }]);
  });

  it('reports now-allowed for a live read production denied and the local rules allow', async () => {
    const fixture = liveCapture(read({ status: 'error', code: 'permission-denied' }), { claims: { admin: true } }, ADMIN_READS);
    const result = await verifyFixture(fixture, { rules: { firestore: ADMIN_READS } });
    expect(result.services.firestore?.divergences).toMatchObject([{ service: 'firestore', kind: 'now-allowed', path: 'rooms/r1', method: 'get' }]);
  });

  const OWNER_READS = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /rooms/{id} { allow read: if resource.data.owner == request.auth.uid; }
  }
}`;
  const EMAIL_READS = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /rooms/{id} { allow read: if request.auth.token.email == 'alice@example.com'; }
  }
}`;

  it('skips a live call whose answer rests on data the capture lacks, under unchanged rules', async () => {
    const cases: Array<[string, ObservedValues]> = [
      [OWNER_READS, {}],
      [ADMIN_READS, {}],
      [EMAIL_READS, { claims: { admin: true } }],
      [OWNER_WRITES, {}],
    ];
    for (const [rules, values] of cases) {
      const call = rules === OWNER_WRITES ? write : read({ status: 'ok' });
      const result = await verifyFixture(liveCapture(call, values, rules), { rules: { firestore: rules } });
      expect(result.ok).toBe(true);
      expect(result.services.firestore?.divergences).toEqual([]);
      expect(result.services.firestore?.checkedEvents).toBe(0);
    }
  });

  it('replays a live read with the document it returned, and reports a real rules change', async () => {
    const fixture = liveCapture(read({ status: 'ok' }), { document: { owner: 'alice' } }, OWNER_READS);
    const unchanged = await verifyFixture(fixture, { rules: { firestore: OWNER_READS } });
    expect(unchanged.services.firestore?.divergences).toEqual([]);
    expect(unchanged.services.firestore?.checkedEvents).toBe(1);
    const closed = await verifyFixture(fixture, { rules: { firestore: NO_ONE } });
    expect(closed.services.firestore?.divergences).toMatchObject([{ kind: 'now-denied', path: 'rooms/r1', method: 'get' }]);
  });

  it('replays a live write with the data it sent', async () => {
    const agrees = await verifyFixture(liveCapture(write, { writeData: { owner: 'alice' } }, OWNER_WRITES), { rules: { firestore: OWNER_WRITES } });
    expect(agrees.services.firestore?.divergences).toEqual([]);
    const differs = await verifyFixture(liveCapture(write, { writeData: { owner: 'bob' } }, OWNER_WRITES), { rules: { firestore: OWNER_WRITES } });
    expect(differs.services.firestore?.divergences).toMatchObject([{ kind: 'now-denied', path: 'rooms/r1', method: 'set' }]);
  });

  it('evaluates live calls whose rules read request.auth.token.email when email claims are captured', async () => {
    const allowed = liveCapture(read({ status: 'ok' }), { claims: { email: 'alice@example.com' } }, EMAIL_READS);
    const agrees = await verifyFixture(allowed, { rules: { firestore: EMAIL_READS } });
    expect(agrees.services.firestore?.checkedEvents).toBe(1);
    expect(agrees.services.firestore?.divergences).toEqual([]);

    const differs = await verifyFixture(
      liveCapture(read({ status: 'ok' }), { claims: { email: 'bob@example.com' } }, EMAIL_READS),
      { rules: { firestore: EMAIL_READS } },
    );
    expect(differs.services.firestore?.checkedEvents).toBe(1);
    expect(differs.services.firestore?.divergences).toMatchObject([{ kind: 'now-denied', path: 'rooms/r1', method: 'get' }]);
  });

  it('evaluates request.auth.token.email rules when claimNames show the token has no email claim', async () => {
    const anonDenied = liveCapture(
      { service: 'firestore', method: 'getDoc', path: 'rooms/r1', at: 1, outcome: { status: 'error', code: 'permission-denied' }, account: { uid: 'anon-1', claimNames: ['sub'] } },
      { claims: { sub: 'anon-1' } },
      EMAIL_READS,
    );
    const agrees = await verifyFixture(anonDenied, { rules: { firestore: EMAIL_READS } });
    expect(agrees.services.firestore?.checkedEvents).toBe(1);
    expect(agrees.services.firestore?.divergences).toEqual([]);

    const anonAllowed = liveCapture(
      { service: 'firestore', method: 'getDoc', path: 'rooms/r1', at: 1, outcome: { status: 'ok' }, account: { uid: 'anon-1', claimNames: ['sub'] } },
      { claims: { sub: 'anon-1' } },
      EMAIL_READS,
    );
    const differs = await verifyFixture(anonAllowed, { rules: { firestore: EMAIL_READS } });
    expect(differs.services.firestore?.checkedEvents).toBe(1);
    expect(differs.services.firestore?.divergences).toMatchObject([{ kind: 'now-denied', path: 'rooms/r1', method: 'get' }]);
  });

  it('evaluates rules reading request.auth.token.firebase.identities.email from captured claims', async () => {
    const identityEmailRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /rooms/{id} { allow read: if 'alice@example.com' in request.auth.token.firebase.identities.email; }
  }
}`;
    const captured = liveCapture(
      read({ status: 'ok' }),
      { claims: { email: 'alice@example.com', firebase: { identities: { email: ['alice@example.com'] } } } },
      identityEmailRules,
    );
    const agrees = await verifyFixture(captured, { rules: { firestore: identityEmailRules } });
    expect(agrees.services.firestore?.checkedEvents).toBe(1);
    expect(agrees.services.firestore?.divergences).toEqual([]);
  });

  it('skips observed Admin SDK Firestore calls that bypassed Security Rules', async () => {
    const adminRead = liveCapture(
      { service: 'firestore', method: 'getDoc', sdk: 'admin', path: 'rooms/r1', at: 1, outcome: { status: 'ok' } },
      {},
      ADMIN_READS,
    );
    const result = await verifyFixture(adminRead, { rules: { firestore: ADMIN_READS } });
    expect(result.ok).toBe(true);
    expect(result.services.firestore?.checkedEvents).toBe(0);
    expect(result.services.firestore?.divergences).toEqual([]);
  });

  it('checks signed-out live calls against claim-gated candidate rules and evaluates count and aggregate queries', async () => {
    const signedOutAllowed = liveCapture(
      { service: 'firestore', method: 'getDoc', path: 'rooms/r1', at: 1, outcome: { status: 'ok' } },
      {},
      ADMIN_READS,
    );
    const nowDenied = await verifyFixture(signedOutAllowed, { rules: { firestore: ADMIN_READS } });
    expect(nowDenied.ok).toBe(false);
    expect(nowDenied.services.firestore?.checkedEvents).toBe(1);
    expect(nowDenied.services.firestore?.divergences).toMatchObject([
      { service: 'firestore', kind: 'now-denied', path: 'rooms/r1', method: 'get' },
    ]);

    for (const method of ['getCountFromServer', 'getAggregateFromServer'] as const) {
      const aggregateCall = liveCapture(
        { service: 'firestore', method, path: 'rooms', at: 1, outcome: { status: 'ok' }, account: { uid: 'alice' } },
        { claims: { admin: true } },
        ADMIN_READS,
      );
      const checked = await verifyFixture(aggregateCall, { rules: { firestore: NO_ONE } });
      expect(checked.ok).toBe(false);
      expect(checked.services.firestore?.checkedEvents).toBe(1);
      expect(checked.services.firestore?.divergences).toMatchObject([
        { service: 'firestore', kind: 'now-denied', path: 'rooms', method: 'list' },
      ]);
    }
  });

  it('preserves collection-group query scope when verifying live Firestore calls', async () => {
    const groupRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{path=**}/items/{id} { allow read: if true; }
  }
}`;
    const rootOnlyRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} { allow read: if true; }
  }
}`;
    const captured = liveCapture(
      {
        service: 'firestore',
        method: 'getDocs',
        path: 'items',
        query: { scope: 'collection-group' },
        at: 1,
        outcome: { status: 'ok' },
      },
      {},
      groupRules,
    );
    const unchanged = await verifyFixture(captured, { rules: { firestore: groupRules } });
    expect(unchanged.ok).toBe(true);
    expect(unchanged.services.firestore?.checkedEvents).toBe(1);

    const broken = await verifyFixture(captured, { rules: { firestore: rootOnlyRules } });
    expect(broken.ok).toBe(false);
    expect(broken.services.firestore?.divergences).toMatchObject([
      { service: 'firestore', kind: 'now-denied', path: 'items', method: 'list' },
    ]);
  });
});

// ─── Storage rules — capture / restore round-trip ───────────────────────
//
// `services.storage.rules` used to be a typed-but-never-written slot:
// firestore and rtdb rules ride the fixture (captured above), but no
// caller ever passed `storageRules` into `buildVerifyFixture`, and
// `parseVerifyFixture` didn't validate the block. This covers the full
// loop: deployed rules -> captured fixture -> fresh sandbox restore ->
// the restored rules actually enforcing (one denied op).
describe('storage rules — fixture capture and restore', () => {
  const OWNER_ONLY_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{fileName} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

  it('captures the deployed storage rules source into the fixture', async () => {
    const sandbox = initializeSandbox();
    getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('capture'),
      rules: OWNER_ONLY_RULES,
    });

    const fixture = buildVerifyFixture({ sandbox, storageRules: OWNER_ONLY_RULES });

    expect(fixture.services.storage?.rules).toEqual({
      format: 'storage.rules',
      source: OWNER_ONLY_RULES,
    });
    // Round-trips through parse/validate too.
    expect(parseVerifyFixture(fixture).services.storage?.rules.source).toBe(OWNER_ONLY_RULES);
  });

  it('replays a live allow under the bucket name the rules saw (ST-H2-4)', async () => {
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/demo-app.appspot.com/o {
    match /{p=**} { allow read, write: if true; }
  }
}`;
    const sandbox = initializeSandbox();
    getStorageSandbox(sandbox, { dbName: uniqueDbName('bucket-name'), rules });
    const app = createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: 'demo-app.appspot.com' }, uniqueDbName('app'));
    const storage = getStorage(app);
    await uploadBytes(storageRef(storage, 'x/a.txt'), new Uint8Array([1]));
    await getMetadata(storageRef(storage, 'x/a.txt'));
    const result = await verifyFixture(buildVerifyFixture({ sandbox, storageRules: rules }), { rules: { storage: rules } });
    expect(result.services.storage?.checkedEvents).toBe(2);
    expect(result.services.storage?.divergences).toEqual([]);
  });

  it("skips a call production served, whose allow is production's, not the captured rules'", async () => {
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{p=**} { allow read, write: if false; }
  }
}`;
    const sandbox = initializeSandbox();
    getStorageSandbox(sandbox, { dbName: uniqueDbName('observed'), rules });
    const call = {
      service: 'storage' as const,
      method: 'getDownloadURL',
      path: 'avatars/alice.png',
      at: 1,
      outcome: { status: 'ok' as const },
      account: { uid: 'alice' },
      bucket: 'demo-app.appspot.com',
    };
    emitSandboxEvent(sandbox, observedCallEvent(call), { caller: { kind: 'node' } });
    const fixture = buildVerifyFixture({ sandbox, storageRules: rules });
    expect(fixture.events).toContainEqual(expect.objectContaining({ service: 'storage', result: 'allow' }));
    const result = await verifyFixture(fixture, { rules: { storage: rules } });
    expect(result.services.storage?.checkedEvents).toBe(0);
    expect(result.services.storage?.divergences).toEqual([]);
  });

  it('omits the storage block when no storage rules were deployed', () => {
    const fixture = buildVerifyFixture({ sandbox: initializeSandbox() });
    expect(fixture.services.storage).toBeUndefined();
  });

  it('restores captured rules into a fresh sandbox and they enforce (denied op)', async () => {
    // Session 1: deploy rules, capture a fixture.
    const dbName1 = uniqueDbName('restore-src');
    const sandbox1 = initializeSandbox();
    getStorageSandbox(sandbox1.withAuth({ uid: 'alice' }), {
      dbName: dbName1,
      rules: OWNER_ONLY_RULES,
    });
    const fixture = buildVerifyFixture({ sandbox: sandbox1, storageRules: OWNER_ONLY_RULES });

    // Session 2: a FRESH sandbox that never saw the rules directly —
    // restore them from the fixture before anything else opens storage.
    const dbName2 = uniqueDbName('restore-dst');
    const sandbox2 = initializeSandbox();
    restoreStorageRulesFromFixture(fixture, sandbox2);

    // Allowed: alice writing under her own uid.
    const aliceStorage = getStorageSandbox(sandbox2.withAuth({ uid: 'alice' }), { dbName: dbName2 });
    const allowedResult = await uploadBytes(
      storageRef(aliceStorage, 'users/alice/notes.txt'),
      new Blob(['hi']),
      { contentType: 'text/plain' },
    );
    expect(allowedResult.metadata.fullPath).toBe('users/alice/notes.txt');

    // Denied: bob writing under alice's uid — the restored rules are
    // actually enforcing, not just present as inert text.
    const bobStorage = getStorageSandbox(sandbox2.withAuth({ uid: 'bob' }), { dbName: dbName2 });
    await expect(
      uploadBytes(
        storageRef(bobStorage, 'users/alice/hijack.txt'),
        new Blob(['nope']),
        { contentType: 'text/plain' },
      ),
    ).rejects.toThrow(/unauthorized/);
  });

  it('is a no-op when the fixture carries no storage block', () => {
    const fixture = buildVerifyFixture({ sandbox: initializeSandbox() });
    const sandbox = initializeSandbox();
    expect(() => restoreStorageRulesFromFixture(fixture, sandbox)).not.toThrow();
  });

  it('replays a Storage-only journey through verifyFixture and detects tightened candidate rules (ST-CON-7)', async () => {
    const sandbox = initializeSandbox();
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('verify-storage'),
      rules: OWNER_ONLY_RULES,
    });
    await uploadBytes(
      storageRef(storage, 'users/alice/notes.txt'),
      new Blob(['hello']),
      { contentType: 'text/plain', customMetadata: { owner: 'alice' } },
    );
    await getMetadata(storageRef(storage, 'users/alice/notes.txt'));

    const fixture = buildVerifyFixture({ sandbox, storageRules: OWNER_ONLY_RULES });
    expect(fixtureVerifiableServices(fixture)).toEqual(['storage']);

    const passResult = await verifyFixture(fixture, {
      rules: { storage: OWNER_ONLY_RULES },
    });
    expect(passResult.ok).toBe(true);
    expect(passResult.services.storage?.checkedEvents).toBe(2);
    expect(passResult.services.storage?.divergences).toEqual([]);

    const denyAllStorageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}`;
    const failResult = await verifyFixture(fixture, {
      rules: { storage: denyAllStorageRules },
    });
    expect(failResult.ok).toBe(false);
    expect(failResult.services.storage?.divergences.map((d) => d.kind)).toEqual([
      'now-denied',
      'now-denied',
    ]);
  });

  it('verifies a Storage-only session using cross-service firestore.get() and firestore.exists() over seeded Firestore documents without requiring candidate Firestore rules', async () => {
    const crossServiceStorageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileName} {
      allow write: if request.auth != null
        && firestore.exists(/databases/(default)/documents/members/$(request.auth.uid))
        && firestore.get(/databases/(default)/documents/orgs/o1).data.canUpload == true;
    }
  }
}`;
    const tightenedStorageRules = crossServiceStorageRules.replace(
      'canUpload == true',
      "tier == 'enterprise'",
    );

    const sandbox = initializeSandbox();
    seedFirestoreDocuments(sandbox, { 'orgs/o1': { canUpload: true, tier: 'starter' } });
    await getAdminFirestore(sandbox).doc('members/alice').set({ active: true });
    await getStorageSandbox(sandbox, {
      dbName: uniqueDbName('verify-storage-cross-service'),
      rules: crossServiceStorageRules,
    });
    await uploadBytes(
      storageRef(getStorageSandbox(sandbox.withAuth({ uid: 'alice' })), 'uploads/report.txt'),
      new Blob(['ok']),
      { contentType: 'text/plain' },
    );

    const fixture = parseVerifyFixture(
      JSON.parse(
        JSON.stringify(buildVerifyFixture({ sandbox, storageRules: crossServiceStorageRules })),
      ),
    );
    expect(fixtureVerifiableServices(fixture)).toEqual(['storage']);

    const sameResult = await verifyFixture(fixture, {
      rules: { storage: crossServiceStorageRules },
    });
    expect(sameResult.ok).toBe(true);
    expect(sameResult.services.firestore).toBeUndefined();
    expect(sameResult.services.storage?.checkedEvents).toBe(1);
    expect(sameResult.services.storage?.divergences).toEqual([]);

    const tightenedResult = await verifyFixture(fixture, {
      rules: { storage: tightenedStorageRules },
    });
    expect(tightenedResult.ok).toBe(false);
    expect(tightenedResult.services.storage?.divergences).toEqual([
      expect.objectContaining({
        service: 'storage',
        kind: 'now-denied',
        path: 'uploads/report.txt',
      }),
    ]);

    const explicitBothResult = await verifyFixture(fixture, {
      rules: { storage: crossServiceStorageRules, firestore: ALICE_RULES },
    });
    expect(explicitBothResult.ok).toBe(true);
    expect(explicitBothResult.services.firestore?.ok).toBe(true);
    expect(explicitBothResult.services.storage?.ok).toBe(true);
  });
});

describe('verifyFixture Firestore list-query provability (#371)', () => {
  const PUBLIC_POSTS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /posts/{id} {
      allow read: if resource.data.visibility == 'public';
    }
  }
}`;

  const TENANT_TIGHTENED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /posts/{id} {
      allow read: if resource.data.visibility == 'public' && resource.data.tenantId == 'acme';
    }
  }
}`;

  async function captureListQueryJourney(): Promise<PyricVerifyFixture> {
    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, PUBLIC_POSTS_RULES);
    await getAdminFirestore(sandbox).doc('posts/p1').set({ visibility: 'public', tenantId: 'acme' });
    const clientDb = getClientFirestore(sandbox.withAuth({ uid: 'alice' }));
    await fsGetDocs(fsQuery(fsCollection(clientDb, 'posts'), fsWhere('visibility', '==', 'public')));
    const unsub = fsOnSnapshot(
      fsQuery(fsCollection(clientDb, 'posts'), fsWhere('visibility', '==', 'public')),
      () => {},
    );
    unsub();
    return buildVerifyFixture({
      sandbox,
      firestoreRules: PUBLIC_POSTS_RULES,
    });
  }

  it('replays captured Firestore list queries and passes when candidate rules remain provable', async () => {
    const fixture = await captureListQueryJourney();
    const result = await verifyFixture(fixture, {
      rules: { firestore: PUBLIC_POSTS_RULES },
    });
    expect(result.ok).toBe(true);
    expect(result.services.firestore?.divergences).toEqual([]);
    expect(result.services.firestore?.checkedEvents).toBeGreaterThanOrEqual(1);
  });

  it('reports now-denied when candidate rules make a captured list query unprovable', async () => {
    const fixture = await captureListQueryJourney();
    const result = await verifyFixture(fixture, {
      rules: { firestore: TENANT_TIGHTENED_RULES },
    });
    expect(result.ok).toBe(false);
    const nowDenied = (result.services.firestore?.divergences ?? []).filter(
      (d) => d.kind === 'now-denied' && d.method === 'list' && d.path === 'posts',
    );
    expect(nowDenied.length).toBeGreaterThanOrEqual(1);
    expect(nowDenied[0]?.reason).toContain('tenantId');

    const casesRun = runDerivedCases(fixture, TENANT_TIGHTENED_RULES);
    if ('error' in casesRun) throw new Error(casesRun.error);
    expect(casesRun.diverged).toBeGreaterThanOrEqual(1);
    const listCase = casesRun.cases.find((c) => c.method === 'list' && c.path === 'posts');
    expect(listCase?.recorded).toBe('allow');
    expect(listCase?.candidate).toBe('deny');
    expect(listCase?.agrees).toBe(false);
    expect(listCase?.queryProof?.verdict).toBe('UNPROVABLE');
  });
});

describe('verifyFixture and deriveRulesTestCases regressions (AV-VER-2..6)', () => {
  it('detects now-allowed on captured denied writes, now-denied on transient writes, and rejects invalid candidate Firestore rules (AV-VER-2 / AV-REP-5)', async () => {
    const strictRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null && request.auth.uid == 'alice';
    }
  }
}`;
    const wideOpenRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} {
      allow read, write: if true;
    }
  }
}`;
    const denyAllRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} {
      allow read, write: if false;
    }
  }
}`;

    // Scenario A: Denied write by mallory becomes allowed under wide-open rules.
    const sandboxA = initializeSandbox();
    const malloryDb = getFirestore(sandboxA.withAuth({ uid: 'mallory' }));
    malloryDb.setRules(strictRules);
    await expect(malloryDb.doc('notes/secret').set({ text: 'pwned' })).rejects.toThrow();
    const fixtureA = buildVerifyFixture({ sandbox: sandboxA, firestoreRules: strictRules });

    const resultA = await verifyFixture(fixtureA, { rules: { firestore: wideOpenRules } });
    expect(resultA.ok).toBe(false);
    expect(resultA.services.firestore?.checkedEvents).toBe(1);
    expect(resultA.services.firestore?.divergences).toEqual([
      expect.objectContaining({
        service: 'firestore',
        kind: 'now-allowed',
        path: 'notes/secret',
      }),
    ]);

    // Scenario B: Allowed write by alice followed by admin delete (final state {}) is now denied.
    const sandboxB = initializeSandbox();
    const aliceDb = getFirestore(sandboxB.withAuth({ uid: 'alice' }));
    const adminDb = getAdminFirestore(sandboxB);
    aliceDb.setRules(strictRules);
    await aliceDb.doc('notes/temp').set({ text: 'draft' });
    await adminDb.doc('notes/temp').delete();
    const fixtureB = buildVerifyFixture({ sandbox: sandboxB, firestoreRules: strictRules });

    const resultB = await verifyFixture(fixtureB, { rules: { firestore: denyAllRules } });
    expect(resultB.ok).toBe(false);
    expect(resultB.services.firestore?.divergences).toEqual([
      expect.objectContaining({
        service: 'firestore',
        kind: 'now-denied',
        path: 'notes/temp',
      }),
    ]);

    // Scenario C: Syntax-invalid candidate Firestore rules throw VerifyInputError.
    await expect(
      verifyFixture(fixtureA, { rules: { firestore: 'THIS WILL NOT PARSE {{{' } }),
    ).rejects.toThrow(VerifyInputError);
  });

  it('preserves denied write payload on existing docs and deleteField() post-state on allowed updates (AV-VER-3)', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
      allow update: if request.auth != null
        && resource.data.owner == request.auth.uid
        && request.resource.data.owner == resource.data.owner
        && !('secret' in request.resource.data);
    }
  }
}`;
    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, rules);
    const clientDb = getClientFirestore(sandbox.withAuth({ uid: 'alice' }));

    await fsSetDoc(fsDoc(clientDb, 'docs/1'), { owner: 'alice', title: 'v1', secret: 'redact-me' });
    await fsUpdateDoc(fsDoc(clientDb, 'docs/1'), { secret: fsDeleteField() });
    await expect(fsUpdateDoc(fsDoc(clientDb, 'docs/1'), { owner: 'bob' })).rejects.toThrow();

    const fixture = buildVerifyFixture({ sandbox, firestoreRules: rules });
    const derived = deriveRulesTestCases(fixture);
    const simulator = new SimulateFirestoreRulesHandler();
    const simResult = simulator.simulate(rules, derived.testCases);
    expect(simResult.success).toBe(true);
    if (!simResult.success) return;

    expect(simResult.data.results[1]?.state).toBe('PASSED');
    expect(simResult.data.results[1]?.decision).toBe('ALLOW');
    expect(derived.testCases[2]?.data?.owner).toBe('bob');
    expect(simResult.data.results[2]?.state).toBe('PASSED');
    expect(simResult.data.results[2]?.decision).toBe('DENY');
  });

  it('detects get()/exists() dependencies on real sandbox-captured RequestEvents (AV-VER-4)', async () => {
    const rulesWithExistsAndGet = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /projects/{projectId} {
      allow get: if request.auth != null
        && exists(/databases/$(database)/documents/admins/$(request.auth.uid))
        && get(/databases/$(database)/documents/admins/$(request.auth.uid)).data.active == true;
    }
  }
}`;
    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, rulesWithExistsAndGet);
    seedFirestoreDocuments(sandbox, {
      'admins/alice': { active: true },
      'projects/p1': { name: 'Apollo' },
    });
    const aliceDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    const snap = await aliceDb.doc('projects/p1').get();
    expect(snap.exists).toBe(true);

    const fixture = buildVerifyFixture({ sandbox, firestoreRules: rulesWithExistsAndGet });
    const strictDerivation = deriveRulesTestCases(fixture, { mockReads: 'strict' });
    const omitDerivation = deriveRulesTestCases(fixture, { mockReads: 'omit' });

    expect(strictDerivation.ok).toBe(false);
    expect(strictDerivation.unsupportedEvents).toHaveLength(1);
    expect(omitDerivation.warnings.some((w) => w.code === 'READ_MOCKS_OMITTED')).toBe(true);
  });

  it('evaluates Firestore read lookups against point-in-time state and preserves pre-seeded documents (AV-VER-5)', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /acl/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /secrets/{docId} {
      allow get: if request.auth != null
        && exists(/databases/$(database)/documents/acl/$(request.auth.uid));
    }
  }
}`;
    // Scenario A: acl/alice exists when secrets/s1 is read, then acl/alice is deleted.
    const sandboxA = initializeSandbox();
    setFirestoreRules(sandboxA, rules);
    const aliceDbA = getFirestore(sandboxA.withAuth({ uid: 'alice' }));
    await aliceDbA.doc('acl/alice').set({ active: true });
    await aliceDbA.doc('secrets/s1').get();
    await aliceDbA.doc('acl/alice').delete();
    const fixtureA = buildVerifyFixture({ sandbox: sandboxA, firestoreRules: rules });

    const verifyA = await verifyFixture(fixtureA, { rules: { firestore: rules } });
    expect(verifyA.ok).toBe(true);
    expect(verifyA.services.firestore?.divergences).toEqual([]);

    // Scenario B: Pre-seeded documents via seedDocuments before session capture.
    const sandboxB = initializeSandbox();
    setFirestoreRules(sandboxB, rules);
    seedFirestoreDocuments(sandboxB, {
      'acl/alice': { active: true },
      'secrets/s1': { text: 'classified' },
    });
    const aliceDbB = getFirestore(sandboxB.withAuth({ uid: 'alice' }));
    await aliceDbB.doc('secrets/s1').get();
    const fixtureB = buildVerifyFixture({ sandbox: sandboxB, firestoreRules: rules });

    const verifyB = await verifyFixture(fixtureB, { rules: { firestore: rules } });
    expect(verifyB.ok).toBe(true);
    expect(verifyB.services.firestore?.divergences).toEqual([]);
  });

  it('preserves non-default Storage bucket on get/list/denied ops and pairs concurrent mutations in FIFO order (AV-VER-6)', async () => {
    const wildcardBucketRulesWithResourceCheck = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{file} {
      allow create: if request.auth != null && request.resource.size > 0;
      allow get: if request.auth != null && resource != null && resource.size > 0;
    }
  }
}`;
    const customBucketFixture: PyricVerifyFixture = {
      schema: 'pyric.verify.fixture.v1',
      events: [
        {
          kind: 'operation',
          id: 'op-upload',
          at: 1000,
          service: 'storage',
          method: 'create',
          path: 'docs/report.pdf',
          auth: { uid: 'alice' },
          result: 'allow',
          origin: 'user',
        },
        {
          kind: 'service_mutation',
          id: 'mut-upload',
          at: 1001,
          service: 'storage',
          op: 'object_put',
          path: 'docs/report.pdf',
          after: {
            fullPath: 'docs/report.pdf',
            bucket: 'my-custom-bucket',
            size: 512,
            contentType: 'application/pdf',
          },
          detail: { bucket: 'my-custom-bucket' },
        },
        {
          kind: 'operation',
          id: 'op-get',
          at: 1002,
          service: 'storage',
          method: 'get',
          path: 'docs/report.pdf',
          auth: { uid: 'alice' },
          result: 'allow',
          origin: 'user',
        },
      ],
      services: {
        storage: {
          rules: { format: 'storage.rules', source: wildcardBucketRulesWithResourceCheck },
          state: null,
        },
      },
    };
    const resultA = await verifyFixture(customBucketFixture, {
      rules: { storage: wildcardBucketRulesWithResourceCheck },
    });
    expect(resultA.ok).toBe(true);
    expect(resultA.services.storage?.divergences).toEqual([]);

    const concurrentUploadsFixture: PyricVerifyFixture = {
      schema: 'pyric.verify.fixture.v1',
      events: [
        {
          kind: 'operation',
          id: 'op-upload-1',
          at: 2000,
          service: 'storage',
          method: 'create',
          path: 'docs/concurrent.pdf',
          auth: { uid: 'alice' },
          result: 'allow',
          origin: 'user',
        },
        {
          kind: 'operation',
          id: 'op-upload-2',
          at: 2001,
          service: 'storage',
          method: 'create',
          path: 'docs/concurrent.pdf',
          auth: { uid: 'alice' },
          result: 'allow',
          origin: 'user',
        },
        {
          kind: 'service_mutation',
          id: 'mut-upload-1',
          at: 2002,
          service: 'storage',
          op: 'object_put',
          path: 'docs/concurrent.pdf',
          after: {
            fullPath: 'docs/concurrent.pdf',
            bucket: 'pyric-default',
            size: 128,
            contentType: 'application/pdf',
          },
          detail: { bucket: 'pyric-default' },
        },
        {
          kind: 'service_mutation',
          id: 'mut-upload-2',
          at: 2003,
          service: 'storage',
          op: 'object_put',
          path: 'docs/concurrent.pdf',
          after: {
            fullPath: 'docs/concurrent.pdf',
            bucket: 'pyric-default',
            size: 256,
            contentType: 'application/pdf',
          },
          detail: { bucket: 'pyric-default' },
        },
      ],
      services: {
        storage: {
          rules: { format: 'storage.rules', source: wildcardBucketRulesWithResourceCheck },
          state: null,
        },
      },
    };
    const resultB = await verifyFixture(concurrentUploadsFixture, {
      rules: { storage: wildcardBucketRulesWithResourceCheck },
    });
    expect(resultB.ok).toBe(true);
    expect(resultB.services.storage?.divergences).toEqual([]);
  });

  it('rehydrates JSON-serialized Firestore wrapper types during verifyFixture write simulation (AV-REP-1c)', async () => {
    const typedRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read, write: if request.auth != null
        && request.resource.data.eventAt is timestamp
        && request.resource.data.payload is bytes
        && request.resource.data.coords is latlng
        && request.resource.data.parentRef.path == 'items/root';
    }
  }
}`;
    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, typedRules);
    const db = getClientFirestore(sandbox.withAuth({ uid: 'alice' }));

    await fsSetDoc(fsDoc(db, 'items/item1'), {
      eventAt: FsTimestamp.fromMillis(1700000000000),
      payload: FsBytes.fromUint8Array(new Uint8Array([1, 2, 3])),
      coords: new FsGeoPoint(37.7749, -122.4194),
      embedding: fsVector([0.1, 0.2, 0.3]),
      parentRef: fsDoc(db, 'items/root'),
      createdAt: fsServerTimestamp(),
    });
    await fsUpdateDoc(fsDoc(db, 'items/item1'), {
      eventAt: FsTimestamp.fromMillis(1700000005000),
      payload: FsBytes.fromUint8Array(new Uint8Array([1, 2, 3])),
      coords: new FsGeoPoint(37.7749, -122.4194),
      embedding: fsVector([0.1, 0.2, 0.3]),
      parentRef: fsDoc(db, 'items/root'),
      updatedAt: fsServerTimestamp(),
    });

    const rawFixture = buildVerifyFixture({ sandbox, firestoreRules: typedRules });
    const persistedFixture = JSON.parse(JSON.stringify(rawFixture)) as PyricVerifyFixture;
    const verifyResult = await verifyFixture(persistedFixture, {
      rules: { firestore: typedRules },
    });

    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.services.firestore?.divergences).toEqual([]);
  });

  it('preserves denied Storage write metadata and evaluates Storage firestore.get against point-in-time Firestore state', async () => {
    const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;
    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{file} {
      allow create: if request.auth != null
        && request.resource.size <= 32
        && request.resource.contentType == 'application/octet-stream'
        && request.resource.metadata == null;
      allow update: if request.auth != null
        && request.resource.metadata != null
        && request.resource.metadata.tier == 'standard';
      allow get: if request.auth != null
        && firestore.exists(/databases/(default)/documents/users/$(request.auth.uid))
        && firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.expiresAt is timestamp
        && firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.badge is bytes
        && firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.orgRef
           == /databases/(default)/documents/orgs/org1;
    }
  }
}`;

    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, firestoreRules);
    const authed = sandbox.withAuth({ uid: 'alice' });
    const db = getClientFirestore(authed);
    const storage = getStorageSandbox(authed, {
      dbName: uniqueDbName('denied-and-pit-firestore'),
      rules: storageRules,
    });

    await fsSetDoc(fsDoc(db, 'users/alice'), {
      expiresAt: FsTimestamp.fromMillis(1700000000000),
      badge: FsBytes.fromUint8Array(new Uint8Array([7, 8])),
      orgRef: fsDoc(db, 'orgs/org1'),
    });

    await uploadBytes(storageRef(storage, 'files/ok.bin'), new Blob(['ok']));
    await getMetadata(storageRef(storage, 'files/ok.bin'));

    await expect(
      uploadBytes(
        storageRef(storage, 'files/oversized.txt'),
        new Blob(['x'.repeat(128)], { type: 'text/plain' }),
        {
          customMetadata: {
            note: 'blocked',
            contact: 'alice@example.com',
            firebaseStorageDownloadTokens: 'secret-download-token-123',
          },
        },
      ),
    ).rejects.toThrow();

    await expect(
      updateMetadata(storageRef(storage, 'files/ok.bin'), {
        customMetadata: { tier: 'vip' },
      }),
    ).rejects.toThrow();

    await fsDeleteDoc(fsDoc(db, 'users/alice'));

    await expect(getMetadata(storageRef(storage, 'files/ok.bin'))).rejects.toThrow();

    const rawFixture = buildVerifyFixture({
      sandbox,
      firestoreRules,
      storageRules,
    });
    const serializedFixture = JSON.stringify(rawFixture);
    expect(serializedFixture).toContain('alice@example.com');
    expect(serializedFixture).toContain('secret-download-token-123');

    const persistedFixture = JSON.parse(serializedFixture) as PyricVerifyFixture;
    const storageOperations = persistedFixture.events.filter(
      (event) => event.kind === 'operation' && event.service === 'storage',
    );
    expect(storageOperations.length).toBe(5);
    for (const op of storageOperations) {
      expect(op.kind === 'operation' && op.detail).toEqual({
        bucket: 'pyric-default',
        bucketName: 'pyric-default',
      });
    }
    const deniedCreate = storageOperations.find(
      (op) => op.kind === 'operation' && op.method === 'create' && op.result === 'deny',
    );
    expect(deniedCreate).toBeDefined();
    expect(persistedFixture.storageDeniedWrites?.[deniedCreate!.id]).toMatchObject({
      requestResource: {
        metadata: {
          note: 'blocked',
          contact: 'alice@example.com',
          firebaseStorageDownloadTokens: 'secret-download-token-123',
        },
      },
    });

    const verifyResult = await verifyFixture(persistedFixture, {
      rules: {
        firestore: firestoreRules,
        storage: storageRules,
      },
    });

    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.services.storage?.checkedEvents).toBe(5);
    expect(verifyResult.services.storage?.unevaluatedEvents).toBeUndefined();
    expect(verifyResult.services.storage?.divergences).toEqual([]);
  });

  it('evaluates denied Storage writes directly against verbatim recorded metadata and token fields without abstaining', async () => {
    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{ownerSegment}/{file} {
      allow create: if request.auth != null
        && request.resource.name == 'uploads/' + ownerSegment + '/' + file
        && request.resource.metadata != null
        && request.resource.metadata.keys().size() == 4
        && request.resource.metadata.owner != request.auth.uid
        && request.resource.metadata.syncToken != 'revoked';
    }
    match /tokens/{file} {
      allow create: if request.auth != null && request.resource.size <= 16;
      allow update: if request.auth != null
        && request.resource.metadata != null
        && resource.metadata != null
        && request.resource.metadata.firebaseStorageDownloadTokens
           == resource.metadata.firebaseStorageDownloadTokens;
    }
    match /plain/{file} {
      allow create: if request.auth != null
        && request.resource.metadata != null
        && request.resource.metadata.ownerEmail == 'bob@example.com'
        && request.resource.metadata.category == 'published';
    }
  }
}`;

    const sandbox = initializeSandbox();
    const authed = sandbox.withAuth({ uid: 'alice@example.com' });
    const storage = getStorageSandbox(authed, {
      dbName: uniqueDbName('redacted-abstention'),
      rules: storageRules,
    });

    // Case 1: Denied upload with email-like owner == uid, syncToken == 'revoked',
    // email segment in object path, and two distinct email-suffixed metadata keys.
    await expect(
      uploadBytes(
        storageRef(storage, 'uploads/alice@example.com/report.txt'),
        new Blob(['hello'], { type: 'text/plain' }),
        {
          customMetadata: {
            owner: 'alice@example.com',
            syncToken: 'revoked',
            'ack:alice@example.com': 'yes',
            'ack:bob@example.com': 'yes',
          },
        },
      ),
    ).rejects.toThrow();

    // Case 2: Download-token immutability rule (`==`). Seed initial object, then attempt rotation.
    await uploadBytes(
      storageRef(storage, 'tokens/item.bin'),
      new Blob(['abcd']),
      {
        customMetadata: { firebaseStorageDownloadTokens: 'tok-initial-111' },
      },
    );
    await expect(
      updateMetadata(storageRef(storage, 'tokens/item.bin'), {
        customMetadata: { firebaseStorageDownloadTokens: 'tok-rotated-222' },
      }),
    ).rejects.toThrow();

    // Case 3: Denied upload with email metadata.
    await expect(
      uploadBytes(
        storageRef(storage, 'plain/draft.txt'),
        new Blob(['draft'], { type: 'text/plain' }),
        {
          customMetadata: { category: 'draft', reviewer: 'team-alpha', ownerEmail: 'bob@example.com' },
        },
      ),
    ).rejects.toThrow();

    const rawFixture = buildVerifyFixture({
      sandbox,
      storageRules,
    });
    const persistedFixture = JSON.parse(JSON.stringify(rawFixture)) as PyricVerifyFixture;

    // Verify `name`, metadata keys, and values are preserved verbatim on Case 1 & Case 2.
    const case1Event = persistedFixture.events.find(
      (event) =>
        event.kind === 'operation' &&
        event.service === 'storage' &&
        event.path === 'uploads/alice@example.com/report.txt',
    );
    expect(case1Event).toBeDefined();
    const case1Denied = persistedFixture.storageDeniedWrites?.[case1Event!.id];
    expect(case1Denied?.requestResource?.name).toBe('uploads/alice@example.com/report.txt');
    expect(case1Denied?.requestResource?.metadata).toEqual({
      owner: 'alice@example.com',
      syncToken: 'revoked',
      'ack:alice@example.com': 'yes',
      'ack:bob@example.com': 'yes',
    });

    const case2UpdateEvent = persistedFixture.events.find(
      (event) =>
        event.kind === 'operation' &&
        event.service === 'storage' &&
        event.method === 'update' &&
        event.path === 'tokens/item.bin',
    );
    expect(case2UpdateEvent).toBeDefined();
    const case2Denied = persistedFixture.storageDeniedWrites?.[case2UpdateEvent!.id];
    expect(case2Denied?.requestResource?.metadata).toEqual({ firebaseStorageDownloadTokens: 'tok-rotated-222' });
    expect(case2Denied?.resource?.metadata).toEqual({ firebaseStorageDownloadTokens: 'tok-initial-111' });

    const case3Event = persistedFixture.events.find(
      (event) =>
        event.kind === 'operation' &&
        event.service === 'storage' &&
        event.path === 'plain/draft.txt',
    );
    expect(case3Event).toBeDefined();

    // Unchanged rules on full session: all 4 Storage operations are evaluated cleanly with zero abstentions!
    const unchangedResult = await verifyFixture(persistedFixture, {
      rules: { storage: storageRules },
    });
    expect(unchangedResult.ok).toBe(true);
    expect(unchangedResult.services.storage?.divergences).toEqual([]);
    expect(unchangedResult.services.storage?.checkedEvents).toBe(4);
    expect(unchangedResult.services.storage?.unevaluatedEvents).toBeUndefined();

    // Also verify Case 2 when `tokens/item.bin` existed prior to the captured event window
    // (`verifyStorage` falls back to `deniedWrite.resource`, which preserves `tok-initial-111` vs `tok-rotated-222`).
    const postSeedFixture: PyricVerifyFixture = {
      ...persistedFixture,
      events: persistedFixture.events.filter(
        (event) => !(event.service === 'storage' && event.path === 'tokens/item.bin' && event.id !== case2UpdateEvent!.id),
      ),
    };
    const postSeedUnchanged = await verifyFixture(postSeedFixture, {
      rules: { storage: storageRules },
    });
    expect(postSeedUnchanged.ok).toBe(true);
    expect(postSeedUnchanged.services.storage?.divergences).toEqual([]);
    expect(postSeedUnchanged.services.storage?.checkedEvents).toBe(3);
    expect(postSeedUnchanged.services.storage?.unevaluatedEvents).toBeUndefined();

    // Loosened candidate rules opening `category == 'draft'` detect `now-allowed` on `plain/draft.txt` across all 4 events.
    const loosenedRules = storageRules.replace(
      "request.resource.metadata.category == 'published'",
      "request.resource.metadata.category in ['published', 'draft']",
    );
    const loosenedResult = await verifyFixture(persistedFixture, {
      rules: { storage: loosenedRules },
    });
    expect(loosenedResult.ok).toBe(false);
    expect(loosenedResult.services.storage?.checkedEvents).toBe(4);
    expect(loosenedResult.services.storage?.divergences).toEqual([
      expect.objectContaining({
        service: 'storage',
        kind: 'now-allowed',
        path: 'plain/draft.txt',
        method: 'create',
      }),
    ]);
    expect(loosenedResult.services.storage?.unevaluatedEvents).toBeUndefined();

    // Candidate rules loosened on `firebaseStorageDownloadTokens` evaluate against the verbatim recorded values
    // (`tok-rotated-222` vs `tok-initial-111`) and report `now-allowed` instead of abstaining.
    const loosenedTokenRules = storageRules.replace(
      `request.resource.metadata.firebaseStorageDownloadTokens
           == resource.metadata.firebaseStorageDownloadTokens`,
      "request.resource.metadata.firebaseStorageDownloadTokens == 'tok-rotated-222'",
    );
    const loosenedTokenResult = await verifyFixture(postSeedFixture, {
      rules: { storage: loosenedTokenRules },
    });
    expect(loosenedTokenResult.ok).toBe(false);
    expect(loosenedTokenResult.services.storage?.checkedEvents).toBe(3);
    expect(loosenedTokenResult.services.storage?.unevaluatedEvents).toBeUndefined();
    expect(loosenedTokenResult.services.storage?.divergences).toEqual([
      expect.objectContaining({
        service: 'storage',
        kind: 'now-allowed',
        path: 'tokens/item.bin',
        method: 'update',
      }),
    ]);

    // Hand-edited fixtures with null/non-object entries or unknown extra properties
    // on `storageDeniedWrites` normalize safely without throwing or exposing extra fields.
    const handEditedFixture: PyricVerifyFixture = {
      ...persistedFixture,
      storageDeniedWrites: {
        ...persistedFixture.storageDeniedWrites,
        [case3Event!.id]: {
          requestResource: {
            ...persistedFixture.storageDeniedWrites?.[case3Event!.id]?.requestResource!,
            unexpectedExtraProp: 'must-be-dropped',
          } as never,
          resource: null as never,
        },
        corruptNullEntry: null as never,
      },
    };
    const strictNoUnknownPropRules = storageRules.replace(
      "request.resource.metadata.category == 'published'",
      "('unexpectedExtraProp' in request.resource) || request.resource.metadata.category == 'published'",
    );
    const handEditedResult = await verifyFixture(handEditedFixture, {
      rules: { storage: strictNoUnknownPropRules },
    });
    expect(handEditedResult.ok).toBe(true);
    expect(handEditedResult.services.storage?.divergences).toEqual([]);
  });

  it('preserves writeMode and updateMask on denied replacing set, merge set, and dot-path update in deriveRulesTestCases and verifyFixture', async () => {
    const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
      allow update: if request.auth != null
        && 'owner' in request.resource.data
        && request.resource.data.owner == resource.data.owner
        && !('keep' in request.resource.data.config);
    }
  }
}`;

    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, firestoreRules);
    const db = getClientFirestore(sandbox.withAuth({ uid: 'alice' }));

    await fsSetDoc(fsDoc(db, 'items/item1'), {
      owner: 'alice',
      config: { keep: 1, theme: 'light' },
    });

    // Denied replacing set: omits owner, so request.resource.data.owner != resource.data.owner.
    await expect(
      fsSetDoc(fsDoc(db, 'items/item1'), { config: { theme: 'dark' } }),
    ).rejects.toThrow(/denied/i);

    // Denied merge set: deep-merges config, leaving config.keep present.
    await expect(
      fsSetDoc(fsDoc(db, 'items/item1'), { config: { theme: 'dark' } }, { merge: true }),
    ).rejects.toThrow(/denied/i);

    // Denied dot-path update: patches config.theme, leaving config.keep present.
    await expect(
      fsUpdateDoc(fsDoc(db, 'items/item1'), { 'config.theme': 'dark' }),
    ).rejects.toThrow(/denied/i);

    const rawFixture = buildVerifyFixture({ sandbox, firestoreRules });
    const persistedFixture = JSON.parse(JSON.stringify(rawFixture)) as PyricVerifyFixture;

    const derived = deriveRulesTestCases(persistedFixture);
    expect(derived.unsupportedEvents).toEqual([]);
    const deniedCases = derived.testCases.filter((tc) => tc.expectation === 'DENY');
    expect(deniedCases).toHaveLength(3);
    expect(deniedCases[0]?.writeMode).toEqual({ kind: 'set', merge: false });
    expect(deniedCases[1]?.writeMode).toEqual({ kind: 'set', merge: true });
    expect(deniedCases[2]?.writeMode).toEqual({ kind: 'update' });
    expect(deniedCases[2]?.data).toEqual({ 'config.theme': 'dark' });

    const verifyResult = await verifyFixture(persistedFixture, {
      rules: { firestore: firestoreRules },
    });
    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.services.firestore?.divergences).toEqual([]);

    // Candidate rules drop the !('keep' in config) requirement while still requiring owner.
    // Replacing set omitted owner so it stays denied (no false now-allowed);
    // merge set and dot-path update retained owner + config.keep, so both become now-allowed.
    const candidateRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
      allow update: if request.auth != null
        && 'owner' in request.resource.data
        && request.resource.data.owner == resource.data.owner
        && request.resource.data.config.keep == 1;
    }
  }
}`;
    const candidateVerify = await verifyFixture(persistedFixture, {
      rules: { firestore: candidateRules },
    });
    const divergences = candidateVerify.services.firestore?.divergences ?? [];
    expect(divergences).toHaveLength(2);
    expect(divergences.every((d) => d.kind === 'now-allowed')).toBe(true);
  });

  it('projects denied batch/tx replacing set, mergeFields, literal-dot FieldPath, and FieldValue sentinels without prototype pollution', async () => {
    const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if true;
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
      allow update: if request.auth != null
        && 'owner' in request.resource.data
        && request.resource.data.owner == resource.data.owner
        && ('approved' in request.resource.data && request.resource.data.approved == true)
        && (!('nested' in request.resource.data) || request.resource.data.nested.leaf != 'blocked')
        && (!('count' in request.resource.data) || request.resource.data.count <= 5);
    }
  }
}`;

    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, firestoreRules);
    const db = getClientFirestore(sandbox.withAuth({ uid: 'alice' }));

    await fsSetDoc(fsDoc(db, 'items/item1'), {
      owner: 'alice',
      approved: true,
      count: 2,
      tags: ['alpha', 'beta'],
      nested: { leaf: 'ok' },
    });

    // (a) Denied batch replacing set on existing doc: omits owner -> must stay { kind: 'set', merge: false }, not merge: true.
    const batch = fsWriteBatch(db);
    batch.set(fsDoc(db, 'items/item1'), { approved: true, count: 1 });
    await expect(batch.commit()).rejects.toThrow(/denied/i);

    // (a2) Denied transaction replacing set on existing doc: omits owner -> must stay { kind: 'set', merge: false }.
    await expect(
      fsRunTransaction(db, async (tx) => {
        tx.set(fsDoc(db, 'items/item1'), { approved: true, count: 1 });
      }),
    ).rejects.toThrow(/denied/i);

    // (b) Denied setDoc with mergeFields: approved=false in existing doc would be overwritten to false?
    // Wait: set approved=false via mergeFields while passing ignoredAllow=true outside mergeFields!
    await expect(
      fsSetDoc(
        fsDoc(db, 'items/item1'),
        { approved: false, unmaskedBypass: true },
        { mergeFields: ['approved'] },
      ),
    ).rejects.toThrow(/denied/i);

    // (c) Denied updateDoc with literal-dot FieldPath('nested.leaf'): sets top-level 'nested.leaf', NOT nested.leaf.
    // Under a rule requiring nested.leaf == 'opened', top-level 'nested.leaf' must NOT split on '.'.
    await expect(
      fsUpdateDoc(
        fsDoc(db, 'items/item1'),
        new FsFieldPath('nested.leaf'),
        'opened',
        'approved',
        false,
      ),
    ).rejects.toThrow(/denied/i);

    // (d1) Denied updateDoc with deleteField() removing owner: 'owner' in request.resource.data must be false, not a sentinel map.
    await expect(
      fsUpdateDoc(fsDoc(db, 'items/item1'), { owner: fsDeleteField() }),
    ).rejects.toThrow(/denied/i);

    // (d2) Denied updateDoc with increment, arrayUnion, arrayRemove, and serverTimestamp.
    await expect(
      fsUpdateDoc(fsDoc(db, 'items/item1'), {
        count: fsIncrement(10),
        tags: fsArrayUnion('gamma'),
        removedTags: fsArrayRemove('beta'),
        stampedAt: fsServerTimestamp(),
      }),
    ).rejects.toThrow(/denied/i);

    const rawFixture = buildVerifyFixture({ sandbox, firestoreRules });
    const persistedFixture = JSON.parse(JSON.stringify(rawFixture)) as PyricVerifyFixture;

    const derived = deriveRulesTestCases(persistedFixture);
    expect(derived.unsupportedEvents).toEqual([]);
    const deniedWriteCases = derived.testCases.filter(
      (tc) => tc.expectation === 'DENY' && tc.method === 'update',
    );
    expect(deniedWriteCases).toHaveLength(6);
    expect(deniedWriteCases[0]?.writeMode).toEqual({ kind: 'set', merge: false });
    expect(deniedWriteCases[1]?.writeMode).toEqual({ kind: 'set', merge: false });

    // Same-rules verification must pass with zero false now-allowed divergences.
    const sameVerify = await verifyFixture(persistedFixture, {
      rules: { firestore: firestoreRules },
    });
    expect(sameVerify.ok).toBe(true);
    expect(sameVerify.services.firestore?.divergences).toEqual([]);

    // Candidate rule checking the exact bug-catch invariants:
    // - (a) batch/tx replacing set omitted 'owner' -> still denied under 'owner' in request.resource.data
    // - (b) mergeFields excluded 'unmaskedBypass' -> still denied under request.resource.data.get('unmaskedBypass', false) == true
    // - (c) literal-dot FieldPath('nested.leaf') wrote top-level 'nested.leaf', NOT nested.leaf == 'opened' -> still denied
    // - (d1) deleteField() removed 'owner' -> still denied under 'owner' in request.resource.data
    // - (d2) increment(10) on count=2 produced 12, arrayUnion added 'gamma', stampedAt == request.time -> ONLY (d2) becomes now-allowed!
    const probeCandidateRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if true;
      allow create: if request.auth != null && request.resource.data.owner == request.auth.uid;
      allow update: if request.auth != null
        && (
          ('owner' in request.resource.data && 'approved' in request.resource.data && request.resource.data.approved == true && 'count' in request.resource.data && request.resource.data.count == 1)
          || ('unmaskedBypass' in request.resource.data && request.resource.data.unmaskedBypass == true)
          || ('nested' in request.resource.data && request.resource.data.nested.leaf == 'opened')
          || ('owner' in request.resource.data && !(request.resource.data.owner is string))
          || (
            request.resource.data.count == 12
            && request.resource.data.tags.hasAll(['alpha', 'beta', 'gamma'])
            && request.resource.data.stampedAt == request.time
          )
        );
    }
  }
}`;
    const probeVerify = await verifyFixture(persistedFixture, {
      rules: { firestore: probeCandidateRules },
    });
    const probeDivergences = probeVerify.services.firestore?.divergences ?? [];
    expect(probeDivergences).toHaveLength(1);
    expect(probeDivergences[0]?.kind).toBe('now-allowed');

    // Prototype-safety check on hand-crafted __proto__ mask in deriveRulesTestCases.
    const protoFixture: PyricVerifyFixture = {
      schema: 'pyric.verify.fixture.v1',
      events: [
        {
          kind: 'request',
          id: 'req-proto-check',
          at: 1700000000000,
          evalMs: 1,
          method: 'update',
          path: 'items/item1',
          auth: { uid: 'alice' },
          result: 'deny',
          reasons: [],
          origin: 'user',
          request: {
            resourceData: JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
            updateMask: [['__proto__']],
          },
          resourceBefore: { data: { owner: 'alice' }, exists: true },
        },
      ],
      services: {
        firestore: {
          rules: { format: 'firestore.rules', source: firestoreRules },
          state: { documents: {} },
        },
      },
    };
    const protoDerived = deriveRulesTestCases(protoFixture);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(protoDerived.testCases[0]?.data ?? {})).toBe(Object.prototype);
  });

  it('preserves Map-shaped request.query.orderBy from ordered Firestore list queries during deriveRulesTestCases and verifyFixture', async () => {
    const orderedRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow list: if request.query.orderBy.score == 'DESC' && request.query.limit <= 10;
    }
  }
}`;
    const sandbox = initializeSandbox();
    const adminDb = getAdminFirestore(sandbox);
    await adminDb.doc('items/item-1').set({ score: 10 });
    setFirestoreRules(sandbox, orderedRules);

    const db = getClientFirestore(sandbox.withAuth({ uid: 'alice' }));
    const snap = await fsGetDocs(
      fsQuery(fsCollection(db, 'items'), fsOrderBy('score', 'desc'), fsLimit(5)),
    );
    expect(snap.docs.map((d) => d.id)).toEqual(['item-1']);

    const fixture = JSON.parse(
      JSON.stringify(buildVerifyFixture({ sandbox, firestoreRules: orderedRules })),
    ) as PyricVerifyFixture;

    const derived = deriveRulesTestCases(fixture);
    const listCase = derived.testCases.find((tc) => tc.method === 'list');
    expect(listCase?.query?.orderBy).toEqual({ score: 'DESC' });
    expect(listCase?.query?.limit).toBe(5);

    const sameVerify = await verifyFixture(fixture, { rules: { firestore: orderedRules } });
    expect(sameVerify.ok).toBe(true);
    expect(sameVerify.services.firestore?.divergences).toEqual([]);

    const ascOnlyRules = orderedRules.replace("== 'DESC'", "== 'ASC'");
    const ascVerify = await verifyFixture(fixture, { rules: { firestore: ascOnlyRules } });
    expect(ascVerify.ok).toBe(false);
    expect(ascVerify.services.firestore?.divergences).toEqual([
      expect.objectContaining({ service: 'firestore', kind: 'now-denied', method: 'list' }),
    ]);
  });

  it('preserves attempted write payload on rolled-back atomic batches in deriveRulesTestCases and flags candidate denials in verifyFixture', async () => {
    const sessionRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/a {
      allow update: if request.auth != null;
    }
    match /items/b {
      allow create: if false;
    }
  }
}`;
    const candidateRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/a {
      allow update: if request.auth != null && request.resource.data.status != 'restricted';
    }
    match /items/b {
      allow create: if false;
    }
  }
}`;

    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, sessionRules);
    seedFirestoreDocuments(sandbox, { 'items/a': { status: 'open', count: 1 } });

    const db = getClientFirestore(sandbox.withAuth({ uid: 'u1' }));
    const batch = fsWriteBatch(db);
    batch.update(fsDoc(db, 'items/a'), { status: 'restricted', count: 2 });
    batch.set(fsDoc(db, 'items/b'), { v: 1 });
    await expect(batch.commit()).rejects.toThrow();

    const fixture = buildVerifyFixture({ sandbox, firestoreRules: sessionRules });
    const derived = deriveRulesTestCases(fixture);
    const itemACase = derived.testCases.find((tc) => tc.path === 'items/a');
    expect(itemACase?.data).toEqual({ status: 'restricted', count: 2 });
    expect((derived as { cases?: typeof derived.testCases }).cases).toEqual(derived.testCases);

    const report = await verifyFixture(fixture, { rules: { firestore: candidateRules } });
    expect(report.ok).toBe(false);
    expect(report.services.firestore?.divergences).toEqual([
      expect.objectContaining({
        service: 'firestore',
        kind: 'now-denied',
        path: 'items/a',
        method: 'update',
      }),
    ]);
  });

  it('evaluates exists() and get() against pre-batch state across atomic writeBatch operations in verifyFixture', async () => {
    const preBatchGuardRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/a {
      allow create: if request.auth != null;
    }
    match /items/b {
      allow create: if request.auth != null
        && !exists(/databases/$(db)/documents/items/a)
        && existsAfter(/databases/$(db)/documents/items/a);
    }
  }
}`;
    const invertedCandidateRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/a {
      allow create: if request.auth != null;
    }
    match /items/b {
      allow create: if request.auth != null && exists(/databases/$(db)/documents/items/a);
    }
  }
}`;

    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, preBatchGuardRules);
    const db = getClientFirestore(sandbox.withAuth({ uid: 'u1' }));
    const batch = fsWriteBatch(db);
    batch.set(fsDoc(db, 'items/a'), { v: 1 });
    batch.set(fsDoc(db, 'items/b'), { v: 2 });
    await batch.commit();

    const fixture = buildVerifyFixture({ sandbox, firestoreRules: preBatchGuardRules });

    const sameRulesReport = await verifyFixture(fixture, { rules: { firestore: preBatchGuardRules } });
    expect(sameRulesReport.ok).toBe(true);
    expect(sameRulesReport.services.firestore?.divergences).toEqual([]);

    const invertedRulesReport = await verifyFixture(fixture, {
      rules: { firestore: invertedCandidateRules },
    });
    expect(invertedRulesReport.ok).toBe(false);
    expect(
      invertedRulesReport.services.firestore?.divergences.some(
        (d) => d.kind === 'now-denied' && d.path === 'items/b',
      ),
    ).toBe(true);
  });
});
