import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  getDatabase,
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
import { getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';
import {
  buildVerifyFixture,
  deriveRulesTestCases,
  parseVerifyFixture,
  restoreStorageRulesFromFixture,
  verifyFixture,
  VerifyInputError,
  type PyricVerifyFixture,
} from '../../src/verify/index.js';
import type { ProjectScope } from '../../src/deploy/index.js';

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
      storageRef(aliceStorage, 'b/pyric-default/o/users/alice/notes.txt'),
      new Blob(['hi']),
      { contentType: 'text/plain' },
    );
    expect(allowedResult.metadata.fullPath).toBe('b/pyric-default/o/users/alice/notes.txt');

    // Denied: bob writing under alice's uid — the restored rules are
    // actually enforcing, not just present as inert text.
    const bobStorage = getStorageSandbox(sandbox2.withAuth({ uid: 'bob' }), { dbName: dbName2 });
    await expect(
      uploadBytes(
        storageRef(bobStorage, 'b/pyric-default/o/users/alice/hijack.txt'),
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
});
