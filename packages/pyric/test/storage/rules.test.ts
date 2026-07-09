/**
 * Slice 8 — Storage rules.
 *
 * Split into two sections:
 *   1. Parser + evaluator unit tests (paths, expressions, wildcards)
 *   2. Operation integration (uploadBytes / getBlob / deleteObject
 *      / getMetadata / updateMetadata gate on configured rules)
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  getBlob,
  deleteObject,
  getMetadata,
  updateMetadata,
  parseStorageRules,
  evaluateStorageRules,
} from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

const SESSION_ARCHIVE_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /sessions/{sessionId} {
      allow write: if request.auth != null
                   && (request.resource == null
                       || (request.resource.size < 10 * 1024 * 1024
                           && request.resource.contentType == 'application/json'));
      allow read: if request.auth != null;
    }
  }
}`;

// Owner-scoped ruleset exercising `resource.metadata.*` (existing
// object's custom metadata) on reads and `request.resource.metadata.*`
// (about-to-write custom metadata) on writes. Regression cover for
// #764 — before the fix both bindings read `undefined` and the
// authorization comparisons failed open.
const METADATA_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow read: if resource.metadata.owner == request.auth.uid;
      allow write: if request.resource.metadata.owner == request.auth.uid;
    }
  }
}`;

// ─── Parser + evaluator unit tests ────────────────────────────────

describe('parseStorageRules', () => {
  it('parses the canonical session-archive ruleset', () => {
    const rules = parseStorageRules(SESSION_ARCHIVE_RULES);
    expect(rules).toBeDefined();
  });

  it('rejects unknown service header', () => {
    expect(() =>
      parseStorageRules(`service cloud.firestore { match /x { allow read: if true; } }`),
    ).toThrow();
  });

  it('rejects unsupported verbs in the v1 scope subset', () => {
    expect(() =>
      parseStorageRules(`service firebase.storage {
        match /b/{bucket}/o {
          match /x/{id} { allow get: if true; }
        }
      }`),
    ).toThrow(/Unsupported verb "get"/);
  });

  it('rejects unterminated strings', () => {
    expect(() =>
      parseStorageRules(`service firebase.storage {
        match /b/{bucket}/o {
          match /x { allow read: if 'unterminated; }
        }
      }`),
    ).toThrow();
  });
});

describe('evaluateStorageRules', () => {
  const rules = parseStorageRules(SESSION_ARCHIVE_RULES);

  it('allows authenticated reads of /sessions/{id}', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path: 'b/pyric-default/o/sessions/s1.json' },
      resource: { size: 12 },
    });
    expect(r.allowed).toBe(true);
  });

  it('denies anonymous reads', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: null, method: 'read', path: 'b/pyric-default/o/sessions/s1.json' },
      resource: { size: 12 },
    });
    expect(r.allowed).toBe(false);
  });

  it('allows JSON writes under 10MB', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'write',
        path: 'b/pyric-default/o/sessions/s1.json',
        resource: { size: 1024, contentType: 'application/json' },
      },
      resource: null,
    });
    expect(r.allowed).toBe(true);
  });

  it('denies writes that exceed the size limit', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'write',
        path: 'b/pyric-default/o/sessions/s1.json',
        resource: { size: 11 * 1024 * 1024, contentType: 'application/json' },
      },
      resource: null,
    });
    expect(r.allowed).toBe(false);
  });

  it('denies writes with the wrong contentType', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'write',
        path: 'b/pyric-default/o/sessions/s1.json',
        resource: { size: 1024, contentType: 'text/plain' },
      },
      resource: null,
    });
    expect(r.allowed).toBe(false);
  });

  it('denies paths that do not match any block', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path: 'b/pyric-default/o/other/x.json' },
      resource: { size: 12 },
    });
    expect(r.allowed).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('supports the {allPaths=**} wildcard', () => {
    const wild = parseStorageRules(`
      service firebase.storage {
        match /b/{bucket}/o {
          match /{allPaths=**} {
            allow read, write: if request.auth != null;
          }
        }
      }`);
    const r = evaluateStorageRules(wild, {
      request: { auth: { uid: 'alice' }, method: 'read', path: 'b/pyric-default/o/anything/at/depth.json' },
      resource: null,
    });
    expect(r.allowed).toBe(true);
  });

  it('honors token claims in conditions', () => {
    const admin = parseStorageRules(`
      service firebase.storage {
        match /b/{bucket}/o {
          match /admin/{id} {
            allow read: if request.auth.token['role'] == 'admin';
          }
        }
      }`);
    expect(
      evaluateStorageRules(admin, {
        request: { auth: { uid: 'a', token: { role: 'admin' } }, method: 'read', path: 'b/pyric-default/o/admin/secret.json' },
        resource: null,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateStorageRules(admin, {
        request: { auth: { uid: 'a', token: { role: 'viewer' } }, method: 'read', path: 'b/pyric-default/o/admin/secret.json' },
        resource: null,
      }).allowed,
    ).toBe(false);
  });
});

describe('evaluateStorageRules — metadata bindings (#764)', () => {
  const rules = parseStorageRules(METADATA_RULES);
  const path = 'b/pyric-default/o/docs/d1.json';

  it('allows a read when resource.metadata.owner matches request.auth.uid', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 12, metadata: { owner: 'alice' } },
    });
    expect(r.allowed).toBe(true);
  });

  it('denies a read when resource.metadata.owner is a different user', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'bob' }, method: 'read', path },
      resource: { size: 12, metadata: { owner: 'alice' } },
    });
    expect(r.allowed).toBe(false);
  });

  it('denies an anonymous read against resource.metadata.owner', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: null, method: 'read', path },
      resource: { size: 12, metadata: { owner: 'alice' } },
    });
    expect(r.allowed).toBe(false);
  });

  it('allows a write when request.resource.metadata.owner matches request.auth.uid', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'write',
        path,
        resource: { size: 2, contentType: 'application/json', metadata: { owner: 'alice' } },
      },
      resource: null,
    });
    expect(r.allowed).toBe(true);
  });

  it('denies a write claiming another user in request.resource.metadata.owner', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'bob' },
        method: 'write',
        path,
        resource: { size: 2, contentType: 'application/json', metadata: { owner: 'alice' } },
      },
      resource: null,
    });
    expect(r.allowed).toBe(false);
  });

  it('denies an anonymous write against request.resource.metadata.owner', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: null,
        method: 'write',
        path,
        resource: { size: 2, contentType: 'application/json', metadata: { owner: 'alice' } },
      },
      resource: null,
    });
    expect(r.allowed).toBe(false);
  });
});

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
  it('allows an authed JSON upload to /sessions', async () => {
    const storage = authedStorage('upload-allowed', { uid: 'alice' });
    const r = ref(storage, 'b/pyric-default/o/sessions/s1.json');
    const result = await uploadBytes(r, new Blob(['{}']), {
      contentType: 'application/json',
    });
    expect(result.metadata.fullPath).toBe('b/pyric-default/o/sessions/s1.json');
  });

  it('denies an anonymous upload', async () => {
    const storage = authedStorage('upload-anon', null);
    const r = ref(storage, 'b/pyric-default/o/sessions/s1.json');
    await expect(
      uploadBytes(r, new Blob(['{}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies non-JSON content type', async () => {
    const storage = authedStorage('upload-bad-ct', { uid: 'alice' });
    const r = ref(storage, 'b/pyric-default/o/sessions/s1.txt');
    await expect(
      uploadBytes(r, new Blob(['plain']), { contentType: 'text/plain' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies a path outside /sessions', async () => {
    const storage = authedStorage('upload-bad-path', { uid: 'alice' });
    const r = ref(storage, 'b/pyric-default/o/other/x.json');
    await expect(
      uploadBytes(r, new Blob(['{}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });
});

describe('reads with rules', () => {
  it('allows authed reads', async () => {
    const storage = authedStorage('read-allowed', { uid: 'alice' });
    const r = ref(storage, 'b/pyric-default/o/sessions/s1.json');
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
      ref(aliceStorage, 'b/pyric-default/o/sessions/s1.json'),
      new Blob(['{}']),
      { contentType: 'application/json' },
    );

    const anonStorage = getStorageSandbox(sandbox.withAuth(null), { dbName });
    const r = ref(anonStorage, 'b/pyric-default/o/sessions/s1.json');
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
    const path = 'b/pyric-default/o/sessions/s1.json';
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
    const path = 'b/pyric-default/o/sessions/s1.json';
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
  const path = 'b/pyric-default/o/docs/d1.json';

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
