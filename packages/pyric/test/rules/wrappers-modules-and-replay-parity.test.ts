import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import {
  apply,
  captureFullState,
  fork,
  initializeSandbox,
  replay,
  type SandboxEvent,
} from 'pyric/sandbox';
import {
  Timestamp as FsTimestamp,
  deleteField,
  doc,
  getDoc,
  getFirestore,
  increment,
  setDoc,
  updateDoc,
  writeBatch,
} from 'pyric/firestore';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import {
  evaluateStorageRules,
  getStorageSandbox,
  parseStorageRules,
  ref,
  uploadBytes,
} from 'pyric/storage';
import { firestoreRules, latlng, reference } from 'pyric/rules';
import { Duration, LatLng, Path, RulesValue } from 'pyric/rules/internal';
import { resolveModules } from 'pyric/rules/internal/node';

function uniqueDbName(label: string): string {
  return `pyric-storage-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('Storage firestore.get() value wrapping', () => {
  test('wraps Firestore DocumentReference and serialized ref markers as StoragePath values', async () => {
    const sandbox = initializeSandbox({});
    setFirestoreRules(
      sandbox,
      `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`,
    );

    const authed = sandbox.withAuth({ uid: 'alice' });
    const db = getFirestore(authed);
    await setDoc(doc(db, 'users', 'alice'), { role: 'editor' });
    await setDoc(doc(db, 'items', 'item1'), {
      ownerRef: doc(db, 'users', 'alice'),
      note: '/databases/(default)/documents/users/alice',
    });

    const storageRulesSource = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{itemId} {
      allow write: if firestore.get(/databases/(default)/documents/items/$(itemId)).data.ownerRef is path
        && firestore.get(/databases/(default)/documents/items/$(itemId)).data.note is string
        && !(firestore.get(/databases/(default)/documents/items/$(itemId)).data.note is path)
        && firestore.get(/databases/(default)/documents/items/$(itemId)).data.ownerRef
           == /databases/(default)/documents/users/$(request.auth.uid)
        && firestore.get(
             firestore.get(/databases/(default)/documents/items/$(itemId)).data.ownerRef
           ).data.role == 'editor';
    }
  }
}`;

    const storage = getStorageSandbox(authed, {
      dbName: uniqueDbName('ref-lookup'),
      rules: storageRulesSource,
    });

    await expect(
      uploadBytes(ref(storage, 'files/item1'), new Blob(['payload'])),
    ).resolves.toBeDefined();

    const parsed = parseStorageRules(storageRulesSource);
    for (const ownerRef of [
      reference('users/alice'),
      { __type: 'ref', path: 'users/alice' },
      { __type: 'reference', path: 'users/alice' },
    ]) {
      const docs: Record<string, Record<string, unknown>> = {
        'users/alice': { role: 'editor' },
        'items/item1': { ownerRef, note: '/databases/(default)/documents/users/alice' },
      };
      const verdict = evaluateStorageRules(
        parsed,
        {
          request: {
            auth: { uid: 'alice' },
            method: 'write',
            path: '/b/default-bucket/o/files/item1',
          },
          resource: null,
        },
        new Date('2026-01-01T00:00:00.000Z'),
        {
          get: (p) => docs[p] ?? null,
          exists: (p) => p in docs,
        },
      );
      expect(verdict.allowed).toBe(true);
    }
  });

  test('preserves non-default database IDs on references, strips trailing slashes, and retains slashed Path segments and bindings', () => {
    const parsedNonDefaultCheck = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{itemId} {
      allow get: if firestore.get(/databases/(default)/documents/items/$(itemId)).data.ownerRef
          == /databases/(default)/documents/users/alice
        || firestore.exists(firestore.get(/databases/(default)/documents/items/$(itemId)).data.ownerRef);
    }
  }
}`);

    for (const nonDefaultRef of [
      reference('projects/demo-proj/databases/analytics/documents/users/alice'),
      { __type: 'reference', path: 'projects/demo-proj/databases/analytics/documents/users/alice' },
      { __type: 'ref', path: 'projects/demo-proj/databases/analytics/documents/users/alice/' },
      { path: '/databases/analytics/documents/users/alice/' },
    ]) {
      const docs: Record<string, Record<string, unknown>> = {
        'users/alice': { role: 'editor' },
        'items/item1': { ownerRef: nonDefaultRef },
      };
      const verdict = evaluateStorageRules(
        parsedNonDefaultCheck,
        {
          request: {
            auth: { uid: 'alice' },
            method: 'get',
            path: '/b/default-bucket/o/files/item1',
          },
          resource: null,
        },
        new Date('2026-01-01T00:00:00.000Z'),
        {
          get: (p) => docs[p] ?? null,
          exists: (p) => p in docs,
        },
      );
      expect(verdict.allowed).toBe(false);
    }

    const parsedTrailingSlashDefault = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{itemId} {
      allow get: if firestore.get(/databases/(default)/documents/items/$(itemId)).data.ownerRef
        == /databases/(default)/documents/users/alice;
    }
  }
}`);
    for (const defaultRefWithTrailingSlash of [
      { __type: 'ref', path: '/databases/(default)/documents/users/alice/' },
      { __type: 'reference', path: '/databases/(default)/documents/users/alice/' },
      reference('/databases/(default)/documents/users/alice/'),
    ]) {
      const verdict = evaluateStorageRules(
        parsedTrailingSlashDefault,
        {
          request: { auth: { uid: 'alice' }, method: 'get', path: '/b/default-bucket/o/files/item1' },
          resource: null,
        },
        new Date('2026-01-01T00:00:00.000Z'),
        {
          get: (p) => {
            if (p === 'items/item1') return { ownerRef: defaultRefWithTrailingSlash };
            return null;
          },
          exists: (p) => p === 'items/item1',
        },
      );
      expect(verdict.allowed).toBe(true);
    }

    const parsedUntaggedPathMap = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{itemId} {
      allow get: if firestore.get(/databases/(default)/documents/items/$(itemId)).data.ownerRef is map
        && firestore.get(/databases/(default)/documents/items/$(itemId)).data.ownerRef.path
          == /databases/(default)/documents/users/alice
        && firestore.get(/databases/(default)/documents/items/$(itemId)).data.note is string
        && !(firestore.get(/databases/(default)/documents/items/$(itemId)).data.note is path);
    }
  }
}`);
    const mapVerdict = evaluateStorageRules(
      parsedUntaggedPathMap,
      {
        request: { auth: { uid: 'alice' }, method: 'get', path: '/b/default-bucket/o/files/item1' },
        resource: null,
      },
      new Date('2026-01-01T00:00:00.000Z'),
      {
        get: (p) => {
          if (p === 'items/item1') {
            return {
              ownerRef: { path: reference('/databases/(default)/documents/users/alice/') },
              note: '/databases/(default)/documents/users/alice',
            };
          }
          return null;
        },
        exists: (p) => p === 'items/item1',
      },
    );
    expect(mapVerdict.allowed).toBe(true);

    const parsedSlashedPathLookup = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{itemId} {
      allow get: if firestore.exists(
        firestore.get(/databases/(default)/documents/items/$(itemId)).data.targetPath
      );
    }
  }
}`);
    for (const slashedTarget of [
      new Path(['databases', '(default)', 'documents', 'orgs', 'org1/users/alice'], {
        member: 'org1/users/alice',
      }),
      { __type: 'path', segments: ['databases', '(default)', 'documents', 'orgs', 'org1/users/alice'] },
    ]) {
      const docs: Record<string, Record<string, unknown>> = {
        'orgs/org1/users/alice': { active: true },
        'items/item1': { targetPath: slashedTarget },
      };
      const verdict = evaluateStorageRules(
        parsedSlashedPathLookup,
        {
          request: { auth: { uid: 'alice' }, method: 'get', path: '/b/default-bucket/o/files/item1' },
          resource: null,
        },
        new Date('2026-01-01T00:00:00.000Z'),
        {
          get: (p) => docs[p] ?? null,
          exists: (p) => p in docs,
        },
      );
      expect(verdict.allowed).toBe(false);
    }

    const parsedPathBindingRead = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{itemId} {
      allow get: if firestore.get(/databases/(default)/documents/items/$(itemId)).data.targetPath.orgId == 'org1';
    }
  }
}`);
    const boundPath = new Path(['databases', '(default)', 'documents', 'orgs', 'org1'], {
      orgId: 'org1',
    });
    const bindingVerdict = evaluateStorageRules(
      parsedPathBindingRead,
      {
        request: { auth: { uid: 'alice' }, method: 'get', path: '/b/default-bucket/o/files/item1' },
        resource: null,
      },
      new Date('2026-01-01T00:00:00.000Z'),
      {
        get: (p) => (p === 'items/item1' ? { targetPath: boundPath } : null),
        exists: (p) => p === 'items/item1',
      },
    );
    expect(bindingVerdict.allowed).toBe(true);
  });
});

describe('Firestore replay and branch apply merge/sentinel fidelity', () => {
  const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

  test('replay preserves batch set(..., { merge: true }) deleteField/dotted keys and does not license sentinel drift from denied writes', async () => {
    const sandbox = initializeSandbox({});
    setFirestoreRules(sandbox, OPEN_RULES);
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    await setDoc(doc(db, 'items', 'item1'), {
      keep: 'yes',
      obsolete: 'remove-me',
      count: 1,
    });

    const batch = writeBatch(db);
    batch.set(
      doc(db, 'items', 'item1'),
      {
        obsolete: deleteField(),
        'meta.v1': 'literal-dotted-key',
      },
      { merge: true },
    );
    await batch.commit();

    const sameRulesReplay = replay(
      sandbox.history(),
      OPEN_RULES,
      { pinRequestTime: true },
      sandbox.snapshot().firestore,
    );
    expect(sameRulesReplay.divergences).toEqual([]);
    expect(sameRulesReplay.sandbox.snapshot().firestore['items/item1']).toEqual({
      keep: 'yes',
      count: 1,
      'meta.v1': 'literal-dotted-key',
    });

    await updateDoc(doc(db, 'items', 'item1'), {
      count: increment(4),
    });

    const createOnlyRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow create: if true;
      allow update: if request.resource.data.count == 1;
    }
  }
}`;
    const deniedIncrementReplay = replay(
      sandbox.history(),
      createOnlyRules,
      { pinRequestTime: true },
      sandbox.snapshot().firestore,
    );

    expect(
      deniedIncrementReplay.divergences.some(
        (d) => d.kind === 'real-divergence' && d.path === 'items/item1' && d.field === 'count',
      ),
    ).toBe(true);
    expect(
      deniedIncrementReplay.divergences.some((d) => d.kind === 'sentinel-drift'),
    ).toBe(false);

    // An earlier allowed sentinel write must not mask a later denied sentinel write on the same field.
    const multiStepSandbox = initializeSandbox({});
    setFirestoreRules(multiStepSandbox, OPEN_RULES);
    const multiDb = getFirestore(multiStepSandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(multiDb, 'items', 'item2'), { count: increment(1), label: 'initial' });
    await updateDoc(doc(multiDb, 'items', 'item2'), { count: increment(5), label: 'blocked' });

    const allowFirstDenySecondRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow create: if true;
      allow update: if request.resource.data.label != 'blocked';
    }
  }
}`;
    const partialReplay = replay(
      multiStepSandbox.history(),
      allowFirstDenySecondRules,
      { pinRequestTime: true },
      multiStepSandbox.snapshot().firestore,
    );
    expect(
      partialReplay.divergences.some(
        (d) => d.kind === 'real-divergence' && d.path === 'items/item2' && d.field === 'count',
      ),
    ).toBe(true);
    expect(
      partialReplay.divergences.some(
        (d) => d.kind === 'sentinel-drift' && d.path === 'items/item2' && d.field === 'count',
      ),
    ).toBe(false);
  });

  test('branch apply honors write.merge, batch replacing set, admin bypassRules, and skips denied request payloads', async () => {
    const baseSandbox = initializeSandbox({});
    setFirestoreRules(baseSandbox, OPEN_RULES);
    const baseDb = getFirestore(baseSandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(baseDb, 'items', 'item1'), {
      nested: { a: 1 },
      stale: 'gone',
      views: 10,
    });

    const baseState = await captureFullState(baseSandbox);

    const planSandbox = initializeSandbox({});
    setFirestoreRules(planSandbox, OPEN_RULES);
    const planDb = getFirestore(planSandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(planDb, 'items', 'item1'), {
      nested: { a: 1 },
      stale: 'gone',
      views: 10,
    });
    const checkpointLen = planSandbox.history().length;

    await setDoc(
      doc(planDb, 'items', 'item1'),
      {
        nested: { b: 2 },
        stale: deleteField(),
        views: increment(3),
        reviewedAt: FsTimestamp.fromMillis(1700000000000),
      },
      { merge: true },
    );

    const persistedDeltaEvents = JSON.parse(
      JSON.stringify(planSandbox.history().slice(checkpointLen)),
    ) as SandboxEvent[];

    const branch = await fork(baseState);
    apply(branch, persistedDeltaEvents);

    const branchDb = getFirestore(branch.sandbox.withAuth({ uid: 'alice' }));
    const snap = await getDoc(doc(branchDb, 'items', 'item1'));
    expect(snap.exists()).toBe(true);
    const data = snap.data()!;
    expect(data.nested).toEqual({ a: 1, b: 2 });
    expect('stale' in data).toBe(false);
    expect(data.views).toBe(13);
    expect((data.reviewedAt as FsTimestamp).toMillis()).toBe(1700000000000);

    // Batch replacing set on an existing doc removes omitted fields and keeps literal dotted keys;
    // an earlier denied client write must not poison a subsequent admin write under strict candidate rules.
    const strictRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if true;
      allow write: if request.auth != null && request.resource.data.allowed == true;
    }
  }
}`;
    setFirestoreRules(planSandbox, strictRules);

    await expect(
      setDoc(doc(planDb, 'items', 'item1'), { allowed: false, poisoned: 'from-denied-request' }),
    ).rejects.toThrow();

    const replaceBatch = writeBatch(planDb);
    replaceBatch.set(doc(planDb, 'items', 'item1'), {
      allowed: true,
      'meta.v1': 'flat-dotted',
    });
    await replaceBatch.commit();

    await expect(
      setDoc(doc(planDb, 'items', 'adminDoc'), {
        allowed: false,
        poisoned: 'from-denied-request',
      }),
    ).rejects.toThrow();
    planSandbox.admin.setDocument('items/adminDoc', { allowed: false, seededByAdmin: true });

    const strictDelta = JSON.parse(
      JSON.stringify(planSandbox.history().slice(checkpointLen)),
    ) as SandboxEvent[];

    const strictBranch = await fork(baseState, { firestore: strictRules });
    apply(strictBranch, strictDelta);

    expect(strictBranch.sandbox.admin.getDocument('items/item1')).toEqual({
      allowed: true,
      'meta.v1': 'flat-dotted',
    });
    expect(strictBranch.sandbox.admin.getDocument('items/adminDoc')).toEqual({
      allowed: false,
      seededByAdmin: true,
    });
  });
});

describe('Rules modules lexical shadowing of ambient identifiers', () => {
  test('allows module parameters and let bindings named resource or request while still rejecting invalid unshadowed ambient fields', () => {
    const helperModule = `
export function ownsPayload(resource, request) {
  return resource.owner == request && resource.title is string;
}

export function validTag(doc) {
  let resource = doc.meta;
  let request = doc.owner;
  return resource.tag == 'ok' && request is string;
}

export function mapLookup(math) {
  return math.get('tag', '') == 'ok';
}

export function nonEmptyId(id) {
  return id.size() > 0;
}
`;

    const firestoreSource = `rules_version = '2+modules';
import { ownsPayload, validTag, mapLookup, nonEmptyId } from './helpers';

service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow create: if request.auth != null
        && ownsPayload(request.resource.data, request.auth.uid)
        && validTag(request.resource.data)
        && mapLookup(request.resource.data.meta);
    }

    match /orgs/{resource} {
      allow get: if resource.size() > 0 && nonEmptyId(resource);
    }
  }
}`;

    const resolvedFirestore = resolveModules(firestoreSource, {
      modules: { './helpers': helperModule },
      targetService: 'cloud.firestore',
    });
    expect(resolvedFirestore.success).toBe(true);
    if (!resolvedFirestore.success) return;

    const ruleset = firestoreRules(resolvedFirestore.data.resolved);
    const sim = ruleset.simulate([
      {
        description: 'allows valid item creation',
        expectation: 'ALLOW',
        method: 'create',
        path: 'items/item1',
        auth: { uid: 'alice' },
        data: { owner: 'alice', title: 'Doc', meta: { tag: 'ok' } },
      },
      {
        description: 'denies mismatched owner',
        expectation: 'DENY',
        method: 'create',
        path: 'items/item1',
        auth: { uid: 'bob' },
        data: { owner: 'alice', title: 'Doc', meta: { tag: 'ok' } },
      },
    ]);
    expect(sim.passed).toBe(2);
    expect(sim.failed).toBe(0);

    const storageSource = `rules_version = '2+modules';
import { ownsPayload } from './helpers';

service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{fileId} {
      allow write: if request.auth != null
        && ownsPayload({'owner': uid, 'title': fileId}, request.auth.uid);
    }
  }
}`;
    const resolvedStorage = resolveModules(storageSource, {
      modules: { './helpers': helperModule },
      targetService: 'firebase.storage',
    });
    expect(resolvedStorage.success).toBe(true);

    // Unshadowed invalid ambient field access must still be rejected.
    const invalidAmbientModule = `
export function badHelper() {
  return resource.notARealAmbientProperty == 'x';
}
`;
    const invalidResolved = resolveModules(
      `rules_version = '2+modules';
import { badHelper } from './bad';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if badHelper();
    }
  }
}`,
      { modules: { './bad': invalidAmbientModule }, targetService: 'cloud.firestore' },
    );
    expect(invalidResolved.success).toBe(false);
  });
});

describe('LatLng, Duration, Path wrappers and Storage unknown-call budget parity', () => {
  test('LatLng.equals and distance accept StorageLatLng symmetrically and Duration normalizes -0 to 0', () => {
    const negZeroDuration = Duration.fromValue(0, 's').negated();
    expect(Object.is(negZeroDuration.seconds, 0)).toBe(true);
    expect(Object.is(negZeroDuration.nanos, 0)).toBe(true);
    const directNegZero = new Duration(-0, -0);
    expect(Object.is(directNegZero.seconds, 0)).toBe(true);
    expect(Object.is(directNegZero.nanos, 0)).toBe(true);

    // In Storage rules, firestore.get() exposes Firestore LatLng / Path wrappers while
    // latlng.value(...) and path literals construct StorageLatLng / StoragePath.
    const storageRules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{id} {
      allow get: if firestore.get(/databases/(default)/documents/items/$(id)).data.loc == latlng.value(37.7749, -122.4194)
        && latlng.value(37.7749, -122.4194) == firestore.get(/databases/(default)/documents/items/$(id)).data.loc
        && firestore.get(/databases/(default)/documents/items/$(id)).data.targetPath == /users/alice
        && /users/alice == firestore.get(/databases/(default)/documents/items/$(id)).data.targetPath;
    }
  }
}`);

    const docs: Record<string, Record<string, unknown>> = {
      'items/item1': {
        loc: latlng(37.7749, -122.4194),
        targetPath: Path.fromString('/users/alice'),
      },
    };
    const verdict = evaluateStorageRules(
      storageRules,
      {
        request: {
          auth: { uid: 'alice' },
          method: 'get',
          path: '/b/default-bucket/o/files/item1',
        },
        resource: null,
      },
      new Date('2026-01-01T00:00:00.000Z'),
      {
        get: (p) => docs[p] ?? null,
        exists: (p) => p in docs,
      },
    );
    expect(verdict.allowed).toBe(true);

    // Extract real StorageLatLng and StoragePath values via RulesValue probes in firestoreLookup
    // to verify LatLng.equals, LatLng.distance, and Path.equals symmetrically.
    let capturedStorageLatLng: unknown;
    let capturedStoragePath: unknown;
    const probeRules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{id} {
      allow get: if firestore.get(/databases/(default)/documents/items/probe).data.locProbe == latlng.value(37.78, -122.42)
        && firestore.get(/databases/(default)/documents/items/probe).data.pathProbe == /users/alice;
    }
  }
}`);
    const locProbe = Object.setPrototypeOf(
      {
        typeName: 'latlng',
        equals(other: unknown) {
          capturedStorageLatLng = other;
          return true;
        },
      },
      RulesValue.prototype,
    );
    const pathProbe = Object.setPrototypeOf(
      {
        typeName: 'path',
        equals(other: unknown) {
          capturedStoragePath = other;
          return true;
        },
      },
      RulesValue.prototype,
    );
    evaluateStorageRules(
      probeRules,
      {
        request: { auth: null, method: 'get', path: '/b/default-bucket/o/files/item1' },
        resource: null,
      },
      new Date('2026-01-01T00:00:00.000Z'),
      {
        get: () => ({ locProbe, pathProbe }),
        exists: () => true,
      },
    );
    expect(capturedStorageLatLng).toBeDefined();
    expect(capturedStoragePath).toBeDefined();

    const exactFsPoint = new LatLng(37.78, -122.42);
    expect(exactFsPoint.equals(capturedStorageLatLng)).toBe(true);
    expect((capturedStorageLatLng as RulesValue).equals(exactFsPoint)).toBe(true);

    const nearbyFsPoint = new LatLng(37.7749, -122.4194);
    const dist = nearbyFsPoint.callMethod('distance', [capturedStorageLatLng]);
    expect(typeof dist).toBe('number');
    expect(dist as number).toBeGreaterThan(500);

    const fsPath = Path.fromString('/users/alice');
    expect(fsPath.equals(capturedStoragePath)).toBe(true);
    expect((capturedStoragePath as RulesValue).equals(fsPath)).toBe(true);
  });

  test('Storage rules evaluate arguments and enforce lookup/expression budgets before unknown function or method errors', () => {
    const docs: Record<string, Record<string, unknown>> = {
      'items/a': { ok: true },
      'items/b': { ok: true },
      'items/c': { ok: true },
    };
    const lookup = {
      get: (p: string) => docs[p] ?? null,
      exists: (p: string) => p in docs,
    };

    for (const exprSource of [
      `noSuchFunction(
        firestore.get(/databases/(default)/documents/items/a),
        firestore.get(/databases/(default)/documents/items/b),
        firestore.get(/databases/(default)/documents/items/c)
      ) || true`,
      `'abc'.noSuchMethod(
        firestore.get(/databases/(default)/documents/items/a),
        firestore.get(/databases/(default)/documents/items/b),
        firestore.get(/databases/(default)/documents/items/c)
      ) || true`,
      `(123).lower(
        firestore.get(/databases/(default)/documents/items/a),
        firestore.get(/databases/(default)/documents/items/b),
        firestore.get(/databases/(default)/documents/items/c)
      ) || true`,
      `request.time.hours(
        firestore.get(/databases/(default)/documents/items/a),
        firestore.get(/databases/(default)/documents/items/b),
        firestore.get(/databases/(default)/documents/items/c)
      ) || true`,
      `firestore.get(
        firestore.get(/databases/(default)/documents/items/a),
        firestore.get(/databases/(default)/documents/items/b),
        firestore.get(/databases/(default)/documents/items/c)
      ) || true`,
      `firestore.exists(
        firestore.get(/databases/(default)/documents/items/a),
        firestore.get(/databases/(default)/documents/items/b),
        firestore.get(/databases/(default)/documents/items/c)
      ) || true`,
    ]) {
      const parsed = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{id} {
      allow get: if ${exprSource};
    }
  }
}`);
      const res = evaluateStorageRules(
        parsed,
        {
          request: {
            auth: { uid: 'alice' },
            method: 'get',
            path: '/b/default-bucket/o/files/item1',
          },
          resource: null,
        },
        new Date('2026-01-01T00:00:00.000Z'),
        lookup,
      );
      expect(res.allowed).toBe(false);
    }

    const baseParsed = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{id} {
      allow get: if 'abc'.noSuchMethod() || true;
    }
  }
}`);
    const withArgsParsed = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{id} {
      allow get: if 'abc'.noSuchMethod(1 + 2, 3 + 4) || true;
    }
  }
}`);
    const baseRes = evaluateStorageRules(baseParsed, {
      request: { auth: null, method: 'get', path: '/b/default-bucket/o/files/item1' },
      resource: null,
    });
    const withArgsRes = evaluateStorageRules(withArgsParsed, {
      request: { auth: null, method: 'get', path: '/b/default-bucket/o/files/item1' },
      resource: null,
    });
    const withArgsSecondRes = evaluateStorageRules(withArgsParsed, {
      request: { auth: null, method: 'get', path: '/b/default-bucket/o/files/item1' },
      resource: null,
    });
    expect(baseRes.allowed).toBe(true);
    expect(withArgsRes.allowed).toBe(true);
    expect(withArgsRes.evaluatedExpressions).toBeGreaterThan(baseRes.evaluatedExpressions!);
    expect(withArgsSecondRes.evaluatedExpressions).toBe(withArgsRes.evaluatedExpressions);
  });

  test('Firestore path literals splice interpolated Path values and omit empty segment when {rest=**} matches zero segments', () => {
    const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function targetDocPath(subpath) {
      let p = path(subpath);
      return /databases/$(database)/documents/$(p);
    }

    match /items/{id} {
      allow get: if targetDocPath('orgs/org1') == /databases/(default)/documents/orgs/org1
        && get(targetDocPath('orgs/org1')).data.active == true;
    }

    match /orgs/{orgId}/{rest=**} {
      allow get: if /databases/$(database)/documents/orgs/$(orgId)/$(rest)
          == /databases/(default)/documents/orgs/org1
        && get(/databases/$(database)/documents/mirrors/$(orgId)/$(rest)).data.mirrored == true;
    }
  }
}`);

    const summary = ruleset.simulate([
      {
        description: 'interpolates Path value inside Firestore path literal',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/item1',
        functionMocks: [
          {
            function: 'get',
            path: 'orgs/org1',
            result: { active: true },
          },
        ],
      },
      {
        description: 'zero-segment recursive wildcard does not append empty trailing segment',
        expectation: 'ALLOW',
        method: 'get',
        path: 'orgs/org1',
        functionMocks: [
          {
            function: 'get',
            path: 'mirrors/org1',
            result: { mirrored: true },
          },
        ],
      },
    ]);

    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
  });
});
