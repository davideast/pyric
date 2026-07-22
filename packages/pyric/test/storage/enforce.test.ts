import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import {
  getStorageSandbox, ref, uploadBytes, getBlob, deleteObject,
  getMetadata, updateMetadata,
} from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}
const SESSION_ARCHIVE_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /sessions/{sessionId} {
      allow write: if request.auth != null
                   && (request.method == 'delete'
                       || (request.resource.size < 10 * 1024 * 1024
                           && request.resource.contentType == 'application/json'));
      allow read: if request.auth != null;
    }
  }
}`;

const METADATA_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow read: if resource.metadata.owner == request.auth.uid;
      allow write: if request.resource.metadata.owner == request.auth.uid;
    }
  }
}`;

// ─── Operation integration tests ──────────────────────────────────

function authedStorage(label: string, auth: { uid: string } | null) {
  const sandbox = initializeSandbox({});
  const ctx = sandbox.withAuth(auth);
  return getStorageSandbox(ctx, {
    dbName: uniqueDbName(label),
    rules: SESSION_ARCHIVE_RULES,
  });
}

describe('uploadBytes with rules', () => {
  it('rejects a Firestore-only module during Storage setup', () => {
    const sandbox = initializeSandbox({});
    expect(() => getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('modules-incompatible'),
      rules: `rules_version = '2+modules';
import { immutableFields } from 'lifecycle';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileId} {
      allow create: if immutableFields(['owner']);
    }
  }
}`,
    })).toThrow(/INCOMPATIBLE_FUNCTION.*immutableFields.*firebase\.storage/);
  });

  it('resolves a checked auth module before enforcing Storage rules', async () => {
    const moduleRules = `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileId} {
      allow create: if isAuthenticated();
    }
  }
}`;
    const authedSandbox = initializeSandbox({});
    const authed = getStorageSandbox(authedSandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('modules-auth-allow'),
      rules: moduleRules,
    });
    await expect(
      uploadBytes(ref(authed, 'uploads/a.txt'), new Blob(['ok'])),
    ).resolves.toBeDefined();

    const anonSandbox = initializeSandbox({});
    const anon = getStorageSandbox(anonSandbox.withAuth(null), {
      dbName: uniqueDbName('modules-auth-deny'),
      rules: moduleRules,
    });
    await expect(
      uploadBytes(ref(anon, 'uploads/a.txt'), new Blob(['no'])),
    ).rejects.toThrow(/unauthorized/);
  });

  it('maps ordinary SDK object paths into the canonical bucket rules namespace', async () => {
    const storage = authedStorage('upload-canonical-path', { uid: 'alice' });
    const ordinaryRef = ref(storage, 'sessions/s1.json');

    const result = await uploadBytes(ordinaryRef, new Blob(['{}']), {
      contentType: 'application/json',
    });

    expect(result.metadata.fullPath).toBe('sessions/s1.json');
  });

  it('allows an authed JSON upload to /sessions', async () => {
    const storage = authedStorage('upload-allowed', { uid: 'alice' });
    const r = ref(storage, 'sessions/s1.json');
    const result = await uploadBytes(r, new Blob(['{}']), {
      contentType: 'application/json',
    });
    expect(result.metadata.fullPath).toBe('sessions/s1.json');
  });

  it('denies an anonymous upload', async () => {
    const storage = authedStorage('upload-anon', null);
    const r = ref(storage, 'sessions/s1.json');
    await expect(
      uploadBytes(r, new Blob(['{}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies non-JSON content type', async () => {
    const storage = authedStorage('upload-bad-ct', { uid: 'alice' });
    const r = ref(storage, 'sessions/s1.txt');
    await expect(
      uploadBytes(r, new Blob(['plain']), { contentType: 'text/plain' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies a path outside /sessions', async () => {
    const storage = authedStorage('upload-bad-path', { uid: 'alice' });
    const r = ref(storage, 'other/x.json');
    await expect(
      uploadBytes(r, new Blob(['{}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });
});

describe('reads with rules', () => {
  it('allows authed reads', async () => {
    const storage = authedStorage('read-allowed', { uid: 'alice' });
    const r = ref(storage, 'sessions/s1.json');
    await uploadBytes(r, new Blob(['{"s":1}']), { contentType: 'application/json' });
    const blob = await getBlob(r);
    expect(await blob.text()).toBe('{"s":1}');
  });

  it('denies anonymous reads', async () => {
    // Need to seed under an authed context so the file exists, then
    // re-read anonymously.
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('read-anon');
    const aliceStorage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: SESSION_ARCHIVE_RULES,
    });
    await uploadBytes(
      ref(aliceStorage, 'sessions/s1.json'),
      new Blob(['{}']),
      { contentType: 'application/json' },
    );

    const anonStorage = getStorageSandbox(sandbox.withAuth(null), { dbName });
    const r = ref(anonStorage, 'sessions/s1.json');
    await expect(getBlob(r)).rejects.toThrow(/unauthorized/);
  });
});

describe('deleteObject / metadata with rules', () => {
  it('denies anonymous delete', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('delete-anon');
    const aliceStorage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: SESSION_ARCHIVE_RULES,
    });
    const path = 'sessions/s1.json';
    await uploadBytes(ref(aliceStorage, path), new Blob(['{}']), {
      contentType: 'application/json',
    });

    const anonStorage = getStorageSandbox(sandbox.withAuth(null), { dbName });
    await expect(deleteObject(ref(anonStorage, path))).rejects.toThrow(/unauthorized/);
  });

  it('denies anonymous getMetadata + updateMetadata', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('md-anon');
    const aliceStorage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: SESSION_ARCHIVE_RULES,
    });
    const path = 'sessions/s1.json';
    await uploadBytes(ref(aliceStorage, path), new Blob(['{}']), {
      contentType: 'application/json',
    });

    const anonStorage = getStorageSandbox(sandbox.withAuth(null), { dbName });
    await expect(getMetadata(ref(anonStorage, path))).rejects.toThrow(/unauthorized/);
    await expect(
      updateMetadata(ref(anonStorage, path), { customMetadata: { x: '1' } }),
    ).rejects.toThrow(/unauthorized/);
  });
});

describe('metadata-based authorization threads through real ops (#764)', () => {
  const path = 'docs/d1.json';

  function metadataStorage(sandbox: ReturnType<typeof initializeSandbox>, dbName: string, auth: { uid: string } | null) {
    return getStorageSandbox(sandbox.withAuth(auth), { dbName, rules: METADATA_RULES });
  }

  it('lets an owner write then read their own doc (request/resource.metadata populated)', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('md-owner');
    const alice = metadataStorage(sandbox, dbName, { uid: 'alice' });
    // Write passes because request.resource.metadata.owner === auth.uid.
    await uploadBytes(ref(alice, path), new Blob(['{}']), {
      contentType: 'application/json',
      customMetadata: { owner: 'alice' },
    });
    // Read passes because resource.metadata.owner === auth.uid.
    const blob = await getBlob(ref(alice, path));
    expect(await blob.text()).toBe('{}');
  });

  it('denies a write that claims another user as owner', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('md-write-spoof');
    const bob = metadataStorage(sandbox, dbName, { uid: 'bob' });
    await expect(
      uploadBytes(ref(bob, path), new Blob(['{}']), {
        contentType: 'application/json',
        customMetadata: { owner: 'alice' },
      }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies a non-owner read of a doc owned by someone else', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('md-read-other');
    const alice = metadataStorage(sandbox, dbName, { uid: 'alice' });
    await uploadBytes(ref(alice, path), new Blob(['{}']), {
      contentType: 'application/json',
      customMetadata: { owner: 'alice' },
    });
    const bob = metadataStorage(sandbox, dbName, { uid: 'bob' });
    await expect(getBlob(ref(bob, path))).rejects.toThrow(/unauthorized/);
  });

  it('denies an anonymous read of an owned doc', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('md-read-anon');
    const alice = metadataStorage(sandbox, dbName, { uid: 'alice' });
    await uploadBytes(ref(alice, path), new Blob(['{}']), {
      contentType: 'application/json',
      customMetadata: { owner: 'alice' },
    });
    const anon = metadataStorage(sandbox, dbName, null);
    await expect(getBlob(ref(anon, path))).rejects.toThrow(/unauthorized/);
  });
});

describe('granular verbs thread through real ops (create vs update)', () => {
  // Only `create` is granted: the first upload to a fresh path (a
  // create) succeeds; a second upload over the now-existing object (an
  // update) is denied. The caller classifies the op by object existence.
  const CREATE_ONLY = `
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{fileId} {
      allow create: if request.auth != null;
      allow read: if request.auth != null;
    }
  }
}`;

  const path = 'files/f1.json';

  it('allows the initial create but denies an overwrite update', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('granular-create-only');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName, rules: CREATE_ONLY });
    // First upload = create → allowed.
    await uploadBytes(ref(alice, path), new Blob(['{}']), { contentType: 'application/json' });
    // Second upload over the existing object = update → denied.
    await expect(
      uploadBytes(ref(alice, path), new Blob(['{"v":2}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies a delete when only create/read are granted', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('granular-no-delete');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName, rules: CREATE_ONLY });
    await uploadBytes(ref(alice, path), new Blob(['{}']), { contentType: 'application/json' });
    await expect(deleteObject(ref(alice, path))).rejects.toThrow(/unauthorized/);
  });
});

describe('no-rules mode is open', () => {
  it('uploads + reads succeed when no rules are configured', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox.withAuth(null), {
      dbName: uniqueDbName('no-rules'),
    });
    const r = ref(storage, 'anything/here.txt');
    await uploadBytes(r, new Blob(['ok'])); // no auth, no contentType — allowed
    expect(await (await getBlob(r)).text()).toBe('ok');
  });
});

// ─── Late rules config is loud (silent-rules-wipe guard) ──────────

describe('late rules configuration throws instead of silently discarding', () => {
  const DENY_ALL = `
service firebase.storage {
  match /{allPaths=**} {
    allow read, write: if false;
  }
}`;

  it('optionless first call, rules later → throws (service opened without rules)', () => {
    const sandbox = initializeSandbox({});
    getStorageSandbox(sandbox, { dbName: uniqueDbName('late-rules-open') });
    expect(() =>
      getStorageSandbox(sandbox, { rules: DENY_ALL }),
    ).toThrow(/first storage call/);
  });

  it('admin plane first, rules later → throws (getAdminStorageSandbox opened the service)', async () => {
    const { getAdminStorageSandbox } = await import('../../src/storage/internal.js');
    const sandbox = initializeSandbox({});
    getAdminStorageSandbox(sandbox, { dbName: uniqueDbName('late-rules-admin') });
    expect(() =>
      getStorageSandbox(sandbox, { rules: DENY_ALL }),
    ).toThrow(/already open without rules/);
  });

  it('a DIFFERENT rules source after a rules-configured open → throws', () => {
    const sandbox = initializeSandbox({});
    getStorageSandbox(sandbox, { dbName: uniqueDbName('late-rules-diff'), rules: DENY_ALL });
    expect(() =>
      getStorageSandbox(sandbox, { rules: SESSION_ARCHIVE_RULES }),
    ).toThrow(/different rules source/);
  });

  it('re-supplying the IDENTICAL rules source stays allowed (idempotent per-user handles)', () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('late-rules-same');
    getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName, rules: DENY_ALL });
    expect(() =>
      getStorageSandbox(sandbox.withAuth({ uid: 'bob' }), { dbName, rules: DENY_ALL }),
    ).not.toThrow();
  });
});

// ─── firestore lookups thread through real storage enforcement ────
//
// End-to-end: a storage rule reads a Firestore document from the SAME
// sandbox to authorize an upload (the premium-user pattern). Enforcement
// (`enforce.ts`) builds the lookup capability from the sandbox's admin
// Firestore accessor (`sandbox.admin.getDocument`, a synchronous
// in-memory read) and injects it into the pure evaluator.
const PREMIUM_UPLOAD_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      allow write: if firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.premium == true;
    }
  }
}`;

describe('firestore lookups thread through real storage enforcement', () => {
  const path = 'uploads/report.json';

  it('allows an upload when the user\'s Firestore doc says premium == true', async () => {
    const sandbox = initializeSandbox({});
    // Seed the acting user's Firestore doc via the admin plane.
    sandbox.admin.setDocument('users/alice', { premium: true });
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('fs-premium-allow'),
      rules: PREMIUM_UPLOAD_RULES,
    });
    await uploadBytes(ref(alice, path), new Blob(['{}']), {
      contentType: 'application/json',
    });
    // No throw = allowed.
  });

  it('denies an upload when the user\'s Firestore doc is not premium', async () => {
    const sandbox = initializeSandbox({});
    sandbox.admin.setDocument('users/bob', { premium: false });
    const bob = getStorageSandbox(sandbox.withAuth({ uid: 'bob' }), {
      dbName: uniqueDbName('fs-premium-deny'),
      rules: PREMIUM_UPLOAD_RULES,
    });
    await expect(
      uploadBytes(ref(bob, path), new Blob(['{}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies an upload when the user has no Firestore doc (get on missing doc errors → deny)', async () => {
    const sandbox = initializeSandbox({});
    const carol = getStorageSandbox(sandbox.withAuth({ uid: 'carol' }), {
      dbName: uniqueDbName('fs-premium-missing'),
      rules: PREMIUM_UPLOAD_RULES,
    });
    await expect(
      uploadBytes(ref(carol, path), new Blob(['{}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('reads only the Firestore view owned by the same sandbox', async () => {
    const primary = initializeSandbox({});
    const secondary = initializeSandbox({});
    primary.admin.setDocument('users/alice', { premium: true });
    secondary.admin.setDocument('users/alice', { premium: false });

    const primaryStorage = getStorageSandbox(primary.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('fs-project-primary'),
      rules: PREMIUM_UPLOAD_RULES,
    });
    const secondaryStorage = getStorageSandbox(secondary.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('fs-project-secondary'),
      rules: PREMIUM_UPLOAD_RULES,
    });

    await uploadBytes(ref(primaryStorage, path), new Blob(['{}']));
    await expect(uploadBytes(ref(secondaryStorage, path), new Blob(['{}']))).rejects.toThrow(/unauthorized/);
  });

  it('bypasses Firestore client rules when Storage evaluates its qualified lookup', async () => {
    const sandbox = initializeSandbox({});
    setFirestoreRules(sandbox, `rules_version = '2'; service cloud.firestore {
      match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } }
    }`);
    sandbox.admin.setDocument('users/alice', { premium: true });
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('fs-rules-independent'),
      rules: PREMIUM_UPLOAD_RULES,
    });

    await uploadBytes(ref(storage, path), new Blob(['{}']));
  });
});

// ─── resource object-identity / time fields ───────────────────────────────────

/** Extension guard on the object's FULL path (`resource.name`), plus an
 *  immutability check on the server timestamps. Both fields come from the
 *  persisted object record, so these rules only work if the persistence layer
 *  actually feeds them into the evaluator. */
const OBJECT_IDENTITY_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileId} {
      allow write: if true;
      // Only image objects are readable — matched against the FULL object path.
      allow get: if resource.name.matches('uploads/.*[.]png');
      // A metadata update is allowed only while the object was never modified.
      allow update: if resource.timeCreated == resource.updated;
    }
  }
}`;

describe('resource object-identity / time fields thread through real ops', () => {
  it('resource.name is the FULL object path, so an extension guard admits a .png', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('res-name-png');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: OBJECT_IDENTITY_RULES,
    });
    const path = 'uploads/pic.png';
    await uploadBytes(ref(alice, path), new Blob(['x']), { contentType: 'image/png' });
    const blob = await getBlob(ref(alice, path));
    expect(await blob.text()).toBe('x');
  });

  it('the same guard denies a .txt — the field is read, not silently undefined', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('res-name-txt');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: OBJECT_IDENTITY_RULES,
    });
    const path = 'uploads/notes.txt';
    await uploadBytes(ref(alice, path), new Blob(['x']), { contentType: 'text/plain' });
    await expect(getBlob(ref(alice, path))).rejects.toThrow(/unauthorized/);
  });

  it('resource.timeCreated == resource.updated admits the first metadata update', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('res-immutable');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: OBJECT_IDENTITY_RULES,
    });
    const path = 'uploads/pic.png';
    await uploadBytes(ref(alice, path), new Blob(['x']), { contentType: 'image/png' });
    // Freshly uploaded: timeCreated === updated, so the update is allowed.
    const meta = await updateMetadata(ref(alice, path), { contentType: 'image/png' });
    expect(meta.contentType).toBe('image/png');
  });
});
