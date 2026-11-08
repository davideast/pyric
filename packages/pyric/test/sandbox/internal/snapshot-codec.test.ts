import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox, signInAnonymously } from 'pyric/auth';
import {
  get as getRtdb,
  getAdminDatabase,
  getDatabase,
  ref as rtdbRef,
  sandbox as rtdbSandbox,
  set as setRtdb,
  setWithPriority,
} from 'pyric/database';
import {
  Bytes,
  GeoPoint,
  Timestamp,
  doc,
  getAdminFirestore,
  getDoc,
  getFirestore,
  setDoc,
} from 'pyric/firestore';
import { Reference as RulesReference } from 'pyric/rules/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import {
  InlineStorageLimitError,
  captureSandboxSnapshot,
  decodeSnapshotMap,
  encodeSnapshotMap,
  forkSandbox,
  getInternalEnv,
  restoreSandboxSnapshot,
  setInlineStorageLimitForTesting,
} from 'pyric/sandbox/internal';
import {
  deleteObject,
  getBytes as getStorageBytes,
  getMetadata as getStorageMetadata,
  getStorageSandbox,
  ref as storageRef,
  uploadBytes,
} from 'pyric/storage';
import {
  deployStorageBucketRules,
  getAdminStorageSandbox,
  getStorageRulesResolution,
} from 'pyric/storage/internal';

let nextDbCounter = 1;
function uniqueStorageDbName(): string {
  return `pyric-snapshot-codec-test:${nextDbCounter++}`;
}

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /items/{id} {
      allow read: if request.auth != null
        && resource.data.createdAt is timestamp
        && resource.data.payload is bytes
        && resource.data.location is latlng
        && resource.data.ownerRef is reference
        && resource.data.ownerRef.path == 'users/' + request.auth.uid;
    }
  }
}`;

const RTDB_RULES = {
  rules: {
    items: {
      $id: {
        '.read': 'auth != null',
        '.write': 'auth != null',
      },
    },
  },
};

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{name} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /verified/{id} {
      allow read: if request.auth != null
        && firestore.get(/databases/(default)/documents/items/$(id)).data.createdAt is timestamp
        && firestore.get(/databases/(default)/documents/items/$(id)).data.payload is bytes
        && firestore.get(/databases/(default)/documents/items/$(id)).data.location is latlng
        && firestore.get(/databases/(default)/documents/items/$(id)).data.ownerRef is path
        && firestore.get(/databases/(default)/documents/items/$(id)).data.ownerRef == /databases/(default)/documents/users/$(request.auth.uid);
    }
  }
}`;

describe('Slice 4.1: lossless ValueCodec and captureSandboxSnapshot / restoreSandboxSnapshot', () => {
  it('round-trips Firestore Timestamp, Bytes, GeoPoint, DocumentReference, and marker-shaped plain maps without JSON type loss', async () => {
    const source = initializeSandbox();
    setFirestoreRules(source, FIRESTORE_RULES);

    const sourceDb = getAdminFirestore(source);
    await setDoc(doc(sourceDb, 'users/u1'), { handle: 'alice' });
    const createdAt = new Timestamp(1_700_000_123, 456_000_000);
    const payload = Bytes.fromUint8Array(new Uint8Array([0, 1, 2, 253, 254, 255]));
    const location = new GeoPoint(37.7749, -122.4194);
    const ownerRef = doc(sourceDb, 'users/u1');

    await setDoc(doc(sourceDb, 'items/item-1'), {
      title: 'Widget',
      count: 42,
      createdAt,
      payload,
      location,
      ownerRef,
      nested: [
        new Timestamp(1_700_000_999, 12_000_000),
        { tag: new GeoPoint(-33.8688, 151.2093) },
      ],
      literalTypeMap: {
        type: 'firestore/timestamp/1.0',
        seconds: 'not-a-timestamp',
      },
      literalDunderMap: {
        __type: 'reference',
        note: 'user-owned literal object',
      },
    });
    getInternalEnv(source).adminSetDocument('items/analytics-item', {
      createdAt,
      payload,
      location,
      ownerRef: new RulesReference('projects/demo/databases/analytics/documents/users/u1'),
    });
    const sourceStorage = getAdminStorageSandbox(source, {
      dbName: uniqueStorageDbName(),
      rules: STORAGE_RULES,
    });
    await uploadBytes(
      storageRef(sourceStorage, 'verified/item-1'),
      new Uint8Array([1, 2, 3]),
    );
    await uploadBytes(
      storageRef(sourceStorage, 'verified/analytics-item'),
      new Uint8Array([4, 5, 6]),
    );

    const snapshot = await captureSandboxSnapshot(source);
    expect(snapshot.version).toBe(1);
    expect(snapshot.rules.firestore?.['(default)']).toBe(FIRESTORE_RULES);

    // Plain JSON fields remain unwrapped in the encoded map.
    const encodedItem = snapshot.firestore['(default)']?.['items/item-1'];
    expect(encodedItem?.title).toBe('Widget');
    expect(encodedItem?.count).toBe(42);

    // Survives full JSON serialization and deserialization with zero class retention.
    const roundTrippedSnapshot = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;

    const target = initializeSandbox();
    getAdminStorageSandbox(target, { dbName: uniqueStorageDbName() });
    const { refusals } = await restoreSandboxSnapshot(target, roundTrippedSnapshot);
    expect(refusals).toEqual([]);

    // Non-admin Firestore and cross-service Storage rule evaluations exercise restored wrappers.
    const ownerFirestore = getFirestore(target.withAuth({ uid: 'u1', token: {} }));
    const nonOwnerFirestore = getFirestore(target.withAuth({ uid: 'u2', token: {} }));
    expect((await getDoc(doc(ownerFirestore, 'items/item-1'))).exists()).toBe(true);
    await expect(getDoc(doc(nonOwnerFirestore, 'items/item-1'))).rejects.toThrow();

    const ownerStorage = getStorageSandbox(target.withAuth({ uid: 'u1', token: {} }));
    expect(
      Array.from(new Uint8Array(await getStorageBytes(storageRef(ownerStorage, 'verified/item-1')))),
    ).toEqual([1, 2, 3]);
    await expect(
      getStorageBytes(storageRef(ownerStorage, 'verified/analytics-item')),
    ).rejects.toThrow();

    const targetDb = getAdminFirestore(target);
    const snap = await getDoc(doc(targetDb, 'items/item-1'));
    expect(snap.exists()).toBe(true);
    const data = snap.data()!;

    expect(data.title).toBe('Widget');
    expect(data.count).toBe(42);
    expect(data.createdAt).toBeInstanceOf(Timestamp);
    expect((data.createdAt as Timestamp).seconds).toBe(1_700_000_123);
    expect((data.createdAt as Timestamp).nanoseconds).toBe(456_000_000);

    expect(data.payload).toBeInstanceOf(Bytes);
    expect(Array.from((data.payload as Bytes).toUint8Array())).toEqual([0, 1, 2, 253, 254, 255]);

    expect(data.location).toBeInstanceOf(GeoPoint);
    expect((data.location as GeoPoint).latitude).toBe(37.7749);
    expect((data.location as GeoPoint).longitude).toBe(-122.4194);

    const restoredRef = data.ownerRef as ReturnType<typeof doc>;
    expect(restoredRef.path).toBe('users/u1');
    const referencedUser = await getDoc(restoredRef);
    expect(referencedUser.data()).toEqual({ handle: 'alice' });

    const nested = data.nested as [Timestamp, { tag: GeoPoint }];
    expect(nested[0]).toBeInstanceOf(Timestamp);
    expect(nested[0].seconds).toBe(1_700_000_999);
    expect(nested[1].tag).toBeInstanceOf(GeoPoint);
    expect(nested[1].tag.latitude).toBe(-33.8688);

    expect(data.literalTypeMap).toEqual({
      type: 'firestore/timestamp/1.0',
      seconds: 'not-a-timestamp',
    });
    expect(data.literalDunderMap).toEqual({
      __type: 'reference',
      note: 'user-owned literal object',
    });

    // Direct ValueCodec encodeSnapshotMap / decodeSnapshotMap round-trip on SDK values.
    const directEncoded = encodeSnapshotMap({
      plain: { active: true },
      when: createdAt,
      raw: payload,
      where: location,
      who: ownerRef,
    });
    expect(directEncoded.plain).toEqual({ active: true });
    const directDecoded = decodeSnapshotMap(
      JSON.parse(JSON.stringify(directEncoded)),
      { create: (path) => doc(targetDb, path) },
    );
    expect(directDecoded.when).toBeInstanceOf(Timestamp);
    expect(directDecoded.raw).toBeInstanceOf(Bytes);
    expect(directDecoded.where).toBeInstanceOf(GeoPoint);
    expect((directDecoded.who as { path: string }).path).toBe('users/u1');
  });

  it('preserves RTDB leaf and branch .priority nodes, Storage metadata and bytes, Auth claims/tenants/passwords, and multi-resource rules', async () => {
    const source = initializeSandbox();

    // RTDB default + named instance with priorities and rules
    const defaultDb = getDatabase(source);
    rtdbSandbox.setRules(defaultDb, RTDB_RULES);
    const adminDefaultDb = getAdminDatabase(source);
    await setWithPriority(rtdbRef(adminDefaultDb, 'items/first'), 'alpha', 10);
    await setWithPriority(rtdbRef(adminDefaultDb, 'items/group'), { childA: 1, childB: 2 }, 'high');

    const secondaryUrl = 'https://secondary-ns.firebaseio.com';
    const secondaryDb = getDatabase(source, secondaryUrl);
    const secondaryRules = { rules: { '.read': 'auth != null', '.write': false } };
    rtdbSandbox.setRules(secondaryDb, secondaryRules);
    const adminSecondaryDb = getAdminDatabase(source, secondaryUrl);
    await setWithPriority(rtdbRef(adminSecondaryDb, 'orgs/org-1/rank'), 99, 5);

    // Storage default + named bucket with metadata, bytes, and rules
    const adminStorage = getAdminStorageSandbox(source, {
      dbName: uniqueStorageDbName(),
      rules: STORAGE_RULES,
    });
    await uploadBytes(
      storageRef(adminStorage, 'files/u1/avatar.bin'),
      new Uint8Array([10, 20, 30, 40]),
      {
        contentType: 'application/octet-stream',
        customMetadata: { owner: 'u1', tag: 'primary' },
      },
    );
    const namedBucketStorage = getAdminStorageSandbox(source, { bucket: 'assets.example.test' });
    const namedBucketRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/{name} {
      allow read: if request.auth != null;
    }
  }
}`;
    deployStorageBucketRules(source, 'assets.example.test', namedBucketRules);
    await uploadBytes(
      storageRef(namedBucketStorage, 'orgs/org-1/logo.svg'),
      new TextEncoder().encode('<svg/>'),
      {
        contentType: 'image/svg+xml',
        customMetadata: { orgId: 'org-1' },
      },
    );

    // Auth users with profile metadata, customClaims, tenantId, flags, password, and anonymous account
    const auth = getAuth(source);
    authSandbox.seedUsers(auth, [
      {
        uid: 'u1',
        email: 'u1@example.test',
        password: 'secret-password-1',
        displayName: 'Alice Example',
        photoUrl: 'https://example.test/u1.png',
        phoneNumber: '+15550101',
        emailVerified: true,
        disabled: false,
        customClaims: { role: 'owner', tier: 2 },
        tenantId: 'org-1',
      },
      {
        uid: 'u2',
        email: 'u2@example.test',
        password: 'secret-password-2',
        emailVerified: false,
        disabled: true,
      },
    ]);
    const anonCred = await signInAnonymously(auth);
    const anonUid = anonCred.user.uid;

    const withoutPasswords = await captureSandboxSnapshot(source, { excludePasswords: true });
    expect(JSON.stringify(withoutPasswords)).not.toContain('secret-password-1');
    expect(withoutPasswords.auth.users.find((u) => u.uid === 'u1')?.password).toBeUndefined();

    const fullSnapshot = JSON.parse(
      JSON.stringify(await captureSandboxSnapshot(source)),
    ) as Awaited<ReturnType<typeof captureSandboxSnapshot>>;

    expect(fullSnapshot.rules.rtdb?.['(default)']).toBe(JSON.stringify(RTDB_RULES));
    expect(fullSnapshot.rules.rtdb?.['secondary-ns']).toBe(JSON.stringify(secondaryRules));
    expect(fullSnapshot.rules.storage?.['(default)']).toBe(STORAGE_RULES);
    expect(fullSnapshot.rules.storage?.['assets.example.test']).toBe(namedBucketRules);
    expect(fullSnapshot.storage['(default)']?.[0]?.size).toBe(4);
    expect(fullSnapshot.storage['(default)']?.[0]?.contentType).toBe('application/octet-stream');
    expect(fullSnapshot.storage['(default)']?.[0]?.customMetadata).toEqual({
      owner: 'u1',
      tag: 'primary',
    });

    const target = initializeSandbox();
    getAdminStorageSandbox(target, { dbName: uniqueStorageDbName() });
    const { refusals } = await restoreSandboxSnapshot(target, fullSnapshot);
    expect(refusals).toEqual([]);

    // Verify RTDB priorities and named instance restored
    const restoredFirst = await getRtdb(rtdbRef(getAdminDatabase(target), 'items/first'));
    expect(restoredFirst.val()).toBe('alpha');
    expect(restoredFirst.priority).toBe(10);
    expect(restoredFirst.exportVal()).toEqual({ '.value': 'alpha', '.priority': 10 });

    const restoredGroup = await getRtdb(rtdbRef(getAdminDatabase(target), 'items/group'));
    expect(restoredGroup.val()).toEqual({ childA: 1, childB: 2 });
    expect(restoredGroup.priority).toBe('high');

    const restoredSecondary = await getRtdb(
      rtdbRef(getAdminDatabase(target, secondaryUrl), 'orgs/org-1/rank'),
    );
    expect(restoredSecondary.val()).toBe(99);
    expect(restoredSecondary.priority).toBe(5);

    // Verify Storage default + named bucket objects, metadata, and rules restored
    const targetDefaultStorage = getAdminStorageSandbox(target);
    expect(getStorageRulesResolution(targetDefaultStorage)?.source).toBe(STORAGE_RULES);
    const avatarRef = storageRef(targetDefaultStorage, 'files/u1/avatar.bin');
    const avatarBytes = new Uint8Array(await getStorageBytes(avatarRef));
    expect(Array.from(avatarBytes)).toEqual([10, 20, 30, 40]);
    const avatarMeta = await getStorageMetadata(avatarRef);
    expect(avatarMeta.contentType).toBe('application/octet-stream');
    expect(avatarMeta.customMetadata).toEqual({ owner: 'u1', tag: 'primary' });

    const targetNamedStorage = getAdminStorageSandbox(target, { bucket: 'assets.example.test' });
    expect(getStorageRulesResolution(targetNamedStorage)?.source).toBe(namedBucketRules);
    const logoBytes = new Uint8Array(
      await getStorageBytes(storageRef(targetNamedStorage, 'orgs/org-1/logo.svg')),
    );
    expect(new TextDecoder().decode(logoBytes)).toBe('<svg/>');

    // Verify Auth users restored including profile metadata, claims, tenantId, flags, password, and anonymous state
    const restoredExport = authSandbox.exportUsers(getAuth(target));
    const restoredRecords = authSandbox.listUsers(getAuth(target));
    expect(restoredExport.find((u) => u.uid === 'u1')?.password).toBe('secret-password-1');
    expect(restoredExport.find((u) => u.uid === 'u2')?.password).toBe('secret-password-2');
    const restoredAnonExport = restoredExport.find((u) => u.uid === anonUid);
    expect(restoredAnonExport?.providerId).toBe('anonymous');
    expect(restoredAnonExport?.email).toBeUndefined();
    expect(restoredAnonExport?.password).toBeUndefined();
    expect(restoredRecords.find((u) => u.uid === 'u1')).toMatchObject({
      uid: 'u1',
      email: 'u1@example.test',
      displayName: 'Alice Example',
      photoUrl: 'https://example.test/u1.png',
      phoneNumber: '+15550101',
      emailVerified: true,
      disabled: false,
      customClaims: { role: 'owner', tier: 2 },
      tenantId: 'org-1',
    });
    expect(restoredRecords.find((u) => u.uid === 'u2')).toMatchObject({
      uid: 'u2',
      email: 'u2@example.test',
      emailVerified: false,
      disabled: true,
    });
    expect(restoredRecords.find((u) => u.uid === anonUid)).toMatchObject({
      uid: anonUid,
      email: null,
      isAnonymous: true,
      providerUserInfo: [],
    });
  });

  it('enforces assertInlineStorageFits when an InlineStorageDocument target is supplied', async () => {
    const sandbox = initializeSandbox();
    const storage = getAdminStorageSandbox(sandbox, { dbName: uniqueStorageDbName() });
    await uploadBytes(storageRef(storage, 'files/u1/a.bin'), new Uint8Array([1, 2, 3, 4, 5, 6]));
    await uploadBytes(storageRef(storage, 'files/u1/b.bin'), new Uint8Array([7, 8, 9, 10, 11]));

    const restoreLimit = setInlineStorageLimitForTesting(10);
    try {
      await expect(
        captureSandboxSnapshot(sandbox, {
          inlineStorageDocument: {
            document: 'A test snapshot export',
            instead: 'Shrink stored objects below the limit.',
          },
        }),
      ).rejects.toBeInstanceOf(InlineStorageLimitError);
    } finally {
      restoreLimit();
    }
  });

  it('captures and restores without Node Buffer or process globals across empty and 1/2/3-byte padding payloads', async () => {
    const source = initializeSandbox();
    const sourceStorage = getStorageSandbox(source, {
      dbName: uniqueStorageDbName(),
      rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}`,
    });
    await uploadBytes(storageRef(sourceStorage, 'files/u1/empty.bin'), new Uint8Array([]));
    await uploadBytes(storageRef(sourceStorage, 'files/u1/one.bin'), new Uint8Array([0xff]));
    await uploadBytes(storageRef(sourceStorage, 'files/u1/two.bin'), new Uint8Array([0x00, 0xab]));
    await uploadBytes(
      storageRef(sourceStorage, 'files/u1/three.bin'),
      new Uint8Array([0x12, 0x34, 0x56]),
    );

    const sourceDb = getAdminFirestore(source);
    await setDoc(doc(sourceDb, 'items/bytes-doc'), {
      b0: Bytes.fromUint8Array(new Uint8Array([])),
      b1: Bytes.fromUint8Array(new Uint8Array([0xfe])),
      b2: Bytes.fromUint8Array(new Uint8Array([0xfe, 0xdc])),
    });
    await setRtdb(rtdbRef(getAdminDatabase(source), 'items/count'), 7);

    const target = initializeSandbox();
    getAdminStorageSandbox(target, { dbName: uniqueStorageDbName() });

    const globals = globalThis as Record<string, unknown>;
    const savedBuffer = globals.Buffer;
    const savedProcess = globals.process;
    delete globals.Buffer;
    delete globals.process;
    try {
      const captured = await captureSandboxSnapshot(source);
      const serialized = JSON.parse(JSON.stringify(captured)) as typeof captured;
      await restoreSandboxSnapshot(target, serialized);
    } finally {
      globals.Buffer = savedBuffer;
      globals.process = savedProcess;
    }

    const targetStorage = getAdminStorageSandbox(target);
    expect(
      Array.from(new Uint8Array(await getStorageBytes(storageRef(targetStorage, 'files/u1/empty.bin')))),
    ).toEqual([]);
    expect(
      Array.from(new Uint8Array(await getStorageBytes(storageRef(targetStorage, 'files/u1/one.bin')))),
    ).toEqual([0xff]);
    expect(
      Array.from(new Uint8Array(await getStorageBytes(storageRef(targetStorage, 'files/u1/two.bin')))),
    ).toEqual([0x00, 0xab]);
    expect(
      Array.from(new Uint8Array(await getStorageBytes(storageRef(targetStorage, 'files/u1/three.bin')))),
    ).toEqual([0x12, 0x34, 0x56]);

    const restoredDoc = (await getDoc(doc(getAdminFirestore(target), 'items/bytes-doc'))).data()!;
    expect(Array.from((restoredDoc.b0 as Bytes).toUint8Array())).toEqual([]);
    expect(Array.from((restoredDoc.b1 as Bytes).toUint8Array())).toEqual([0xfe]);
    expect(Array.from((restoredDoc.b2 as Bytes).toUint8Array())).toEqual([0xfe, 0xdc]);
  });
});

describe('Slice 4.2: forkSandbox bidirectional isolation', () => {
  it('forks Firestore, RTDB, Storage, and Auth into an isolated LocalSandbox where mutations never cross', async () => {
    const source = initializeSandbox();
    setFirestoreRules(source, FIRESTORE_RULES);
    const sourceDb = getAdminFirestore(source);
    await setDoc(doc(sourceDb, 'users/u1'), {
      handle: 'alice',
      joinedAt: new Timestamp(1_700_100_000, 0),
    });

    const sourceRtdb = getAdminDatabase(source);
    rtdbSandbox.setRules(getDatabase(source), RTDB_RULES);
    await setWithPriority(rtdbRef(sourceRtdb, 'items/i1'), { name: 'Alpha' }, 3);

    const sourceStorage = getAdminStorageSandbox(source, {
      dbName: uniqueStorageDbName(),
      rules: STORAGE_RULES,
    });
    await uploadBytes(
      storageRef(sourceStorage, 'files/u1/doc.txt'),
      new TextEncoder().encode('original-bytes'),
      { contentType: 'text/plain', customMetadata: { stage: 'seed' } },
    );

    authSandbox.seedUsers(getAuth(source), [
      { uid: 'u1', email: 'u1@example.test', password: 'pw-1', tenantId: 'org-1' },
    ]);

    const { sandbox: forked, snapshot } = await forkSandbox(source);
    expect(snapshot.version).toBe(1);
    expect(snapshot.storage['(default)']).toHaveLength(1);
    expect(forked.history()).toEqual([]);

    // Mutate every service on the fork
    const forkDb = getAdminFirestore(forked);
    await setDoc(doc(forkDb, 'users/u1'), { handle: 'mutated-on-fork' });
    await setDoc(doc(forkDb, 'users/u2'), { handle: 'added-on-fork' });

    const forkRtdb = getAdminDatabase(forked);
    await setWithPriority(rtdbRef(forkRtdb, 'items/i1'), { name: 'Forked' }, 99);

    const forkStorage = getAdminStorageSandbox(forked);
    await deleteObject(storageRef(forkStorage, 'files/u1/doc.txt'));
    await uploadBytes(
      storageRef(forkStorage, 'files/u1/fork-only.txt'),
      new TextEncoder().encode('fork-bytes'),
      { contentType: 'text/plain' },
    );
    authSandbox.clearUsers(getAuth(forked));

    // Source remains completely untouched across all four services
    const sourceSnap = await getDoc(doc(sourceDb, 'users/u1'));
    expect(sourceSnap.data()?.handle).toBe('alice');
    expect((sourceSnap.data()?.joinedAt as Timestamp).seconds).toBe(1_700_100_000);
    expect((await getDoc(doc(sourceDb, 'users/u2'))).exists()).toBe(false);

    const sourceRtdbSnap = await getRtdb(rtdbRef(sourceRtdb, 'items/i1'));
    expect(sourceRtdbSnap.val()).toEqual({ name: 'Alpha' });
    expect(sourceRtdbSnap.priority).toBe(3);

    const sourceBytes = await getStorageBytes(storageRef(sourceStorage, 'files/u1/doc.txt'));
    expect(new TextDecoder().decode(sourceBytes)).toBe('original-bytes');
    await expect(
      getStorageBytes(storageRef(sourceStorage, 'files/u1/fork-only.txt')),
    ).rejects.toThrow();
    expect(authSandbox.exportUsers(getAuth(source))).toHaveLength(1);

    // Mutating source after the fork also never leaks into forked
    await uploadBytes(
      storageRef(sourceStorage, 'files/u1/source-only.txt'),
      new TextEncoder().encode('source-after-fork'),
    );
    await expect(
      getStorageBytes(storageRef(forkStorage, 'files/u1/source-only.txt')),
    ).rejects.toThrow();
  });
});
