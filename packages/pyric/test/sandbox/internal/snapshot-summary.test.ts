import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import {
  getAdminDatabase,
  getDatabase,
  ref as rtdbRef,
  sandbox as rtdbSandbox,
  set as rtdbSet,
  setWithPriority,
} from 'pyric/database';
import { Timestamp, doc, getAdminFirestore, setDoc } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import {
  captureSandboxSnapshot,
  summarizeSandboxSnapshot,
} from 'pyric/sandbox/internal';
import { ref as storageRef, uploadBytes } from 'pyric/storage';
import {
  deployStorageBucketRules,
  getAdminStorageSandbox,
  replaceStorageRules,
} from 'pyric/storage/internal';

let nextDbSeq = 1;

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} { allow read: if request.auth != null && request.auth.uid == uid; }
    match /orgs/{orgId}/items/{id} { allow read: if request.auth != null; }
  }
}`;

const RTDB_RULES = {
  rules: {
    items: {
      $id: {
        '.read': 'auth != null',
      },
    },
  },
};

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{name} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

describe('Slice 4.3: summarizeSandboxSnapshot', () => {
  it('summarizes multi-service rules, counts, and resources without preview by default', async () => {
    const sandbox = initializeSandbox();
    setFirestoreRules(sandbox, FIRESTORE_RULES);

    const db = getAdminFirestore(sandbox);
    await setDoc(doc(db, 'users/u1'), {
      createdAt: new Timestamp(1_700_000_000, 0),
      role: 'member',
    });
    await setDoc(doc(db, 'orgs/org-1/items/item-1'), { title: 'alpha' });
    await setDoc(doc(db, 'orgs/org-1/items/item-2'), { title: 'beta' });

    const defaultRtdb = getDatabase(sandbox);
    rtdbSandbox.setRules(defaultRtdb, RTDB_RULES);
    const adminRtdb = getAdminDatabase(sandbox);
    await setWithPriority(rtdbRef(adminRtdb, 'items/item-1'), 'pinned', 5);
    await rtdbSet(rtdbRef(adminRtdb, 'users/u1'), { online: true });

    const secondaryUrl = 'https://secondary-db.firebaseio.com';
    const secondaryAdmin = getAdminDatabase(sandbox, secondaryUrl);
    await rtdbSet(rtdbRef(secondaryAdmin, 'orgs/org-1'), { plan: 'pro' });

    const defaultStorage = getAdminStorageSandbox(sandbox, {
      dbName: `pyric-summary-default:${nextDbSeq++}`,
    });
    await replaceStorageRules(sandbox, STORAGE_RULES);
    await uploadBytes(
      storageRef(defaultStorage, 'files/u1/avatar.bin'),
      new Uint8Array([1, 2, 3, 4]),
      { contentType: 'application/octet-stream', customMetadata: { owner: 'u1' } },
    );

    const archiveStorage = getAdminStorageSandbox(sandbox, {
      bucket: 'archive-bucket',
      dbName: `pyric-summary-archive:${nextDbSeq++}`,
    });
    deployStorageBucketRules(sandbox, 'archive-bucket', STORAGE_RULES);
    await uploadBytes(
      storageRef(archiveStorage, 'files/u2/export.txt'),
      new Uint8Array([65, 66, 67]),
      { contentType: 'text/plain' },
    );

    authSandbox.seedUsers(getAuth(sandbox), [
      {
        uid: 'u1',
        email: 'u1@example.test',
        password: 'super-secret-password',
        emailVerified: true,
        disabled: false,
        tenantId: 'org-1',
        customClaims: { role: 'owner' },
      },
      {
        uid: 'u2',
        email: 'u2@example.test',
        password: 'second-secret-password',
        emailVerified: false,
        disabled: true,
        tenantId: 'org-2',
      },
    ]);

    const snapshot = await captureSandboxSnapshot(sandbox);
    const summary = summarizeSandboxSnapshot(snapshot);

    expect(summary.firestore).toEqual({
      rulesConfigured: true,
      rulesSizeBytes: new TextEncoder().encode(FIRESTORE_RULES).byteLength,
      databases: ['(default)'],
      totalDocuments: 3,
      byCollection: {
        users: 1,
        'orgs/org-1/items': 2,
      },
    });
    expect(summary.database).toEqual({
      rulesConfigured: true,
      rulesSizeBytes: new TextEncoder().encode(JSON.stringify(RTDB_RULES)).byteLength,
      instances: ['(default)', 'secondary-db'],
      hasData: true,
      topLevelKeys: ['items', 'users'],
      nodeCount: 8,
    });
    expect(summary.storage).toEqual({
      rulesConfigured: true,
      rulesSizeBytes: new TextEncoder().encode(STORAGE_RULES).byteLength * 2,
      buckets: ['(default)', 'archive-bucket'],
      totalObjects: 2,
      totalBytes: 7,
    });
    expect(summary.auth).toEqual({
      totalUsers: 2,
      verifiedUsers: 1,
      disabledUsers: 1,
      tenants: ['org-1', 'org-2'],
    });
  });

  it('produces bounded previews when includeData is true and omits passwords and raw base64', async () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);
    await setDoc(doc(db, 'items/item-1'), { index: 1 });
    await setDoc(doc(db, 'items/item-2'), { index: 2 });
    await setDoc(doc(db, 'items/item-3'), { index: 3 });

    const storage = getAdminStorageSandbox(sandbox, {
      dbName: `pyric-summary-preview:${nextDbSeq++}`,
    });
    await uploadBytes(storageRef(storage, 'files/u1/a.bin'), new Uint8Array([10, 20]), {
      contentType: 'application/octet-stream',
      customMetadata: { tag: 'first' },
    });
    await uploadBytes(storageRef(storage, 'files/u1/b.bin'), new Uint8Array([30, 40, 50]));

    authSandbox.seedUsers(getAuth(sandbox), [
      { uid: 'u1', email: 'u1@example.test', password: 'do-not-leak-password', emailVerified: true },
      { uid: 'u2', email: 'u2@example.test', password: 'do-not-leak-password-2', disabled: true },
    ]);

    const snapshot = await captureSandboxSnapshot(sandbox);

    const globals = globalThis as Record<string, unknown>;
    const savedBuffer = globals.Buffer;
    const savedProcess = globals.process;
    let previewSummary: ReturnType<typeof summarizeSandboxSnapshot>;
    try {
      delete globals.Buffer;
      delete globals.process;
      previewSummary = summarizeSandboxSnapshot(snapshot, {
        includeData: true,
        maxPreviewItems: 1,
      });
    } finally {
      globals.Buffer = savedBuffer;
      globals.process = savedProcess;
    }

    expect(previewSummary.firestore.preview).toEqual({
      truncated: true,
      documents: {
        'items/item-1': { index: 1 },
      },
    });
    expect(previewSummary.storage.preview).toEqual({
      truncated: true,
      objects: [
        {
          bucket: '(default)',
          path: 'files/u1/a.bin',
          size: 2,
          contentType: 'application/octet-stream',
          customMetadata: { tag: 'first' },
        },
      ],
    });
    expect(previewSummary.auth.preview).toEqual({
      truncated: true,
      users: [
        {
          uid: 'u1',
          email: 'u1@example.test',
          emailVerified: true,
          disabled: false,
        },
      ],
    });
    const serialized = JSON.stringify(previewSummary);
    expect(serialized).not.toContain('do-not-leak-password');
    expect(serialized).not.toContain('contentBase64');
  });

  it('guards Object.prototype collection, database, instance, and bucket names', () => {
    const summary = summarizeSandboxSnapshot(
      {
        version: 1,
        rules: {
          firestore: { constructor: 'allow read: if true;' },
          rtdb: { toString: '{"rules":{}}' },
          storage: { valueOf: 'rules_version = "2";' },
        },
        auth: { users: [] },
        firestore: {
          '(default)': {
            'constructor/doc-1': { ok: true },
            'constructor/doc-2': { ok: true },
            'toString/doc-1': { ok: true },
            'valueOf/doc-1': { ok: true },
          },
        },
        rtdb: {},
        storage: {},
      },
      { includeData: true },
    );

    expect(summary.firestore.byCollection.constructor).toBe(2);
    expect(summary.firestore.byCollection.toString).toBe(1);
    expect(summary.firestore.byCollection.valueOf).toBe(1);
    expect(summary.firestore.totalDocuments).toBe(4);
    expect(summary.database.topLevelKeys).toEqual([]);
    expect(summary.storage.totalObjects).toBe(0);
  });
});
