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
  GeoPoint as FsGeoPoint,
  Timestamp as FsTimestamp,
  collection as fsCollection,
  deleteField as fsDeleteField,
  doc as fsDoc,
  getDocs as fsGetDocs,
  getFirestore as getClientFirestore,
  onSnapshot as fsOnSnapshot,
  query as fsQuery,
  serverTimestamp as fsServerTimestamp,
  setDoc as fsSetDoc,
  updateDoc as fsUpdateDoc,
  vector as fsVector,
  where as fsWhere,
} from 'pyric/firestore';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { setRules as setFirestoreRules, seedDocuments as seedFirestoreDocuments } from 'pyric/sandbox/firestore';
import { runDerivedCases } from '../../src/bridge/surface/assurance-cases.js';
import { getMetadata, getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';
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
});
