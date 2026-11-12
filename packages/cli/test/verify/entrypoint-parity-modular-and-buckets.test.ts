import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from 'pyric/app/internal';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import {
  deleteObject,
  getBytes,
  getStorage,
  getStorageSandbox,
  ref as storageRef,
  updateMetadata,
  uploadBytes,
} from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { firestoreRules, RulesCompileError } from 'pyric/rules';
import {
  buildVerifyFixture,
  verifyFixture,
  VerifyInputError,
} from '../../src/verify/index.js';

describe('rules_version = "2+modules" Firestore rules in firestoreRules() and verifyFixture()', () => {
  const PLAIN_FS_RULES = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /items/{id} {',
    '      allow read, write: if request.auth != null;',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const MODULAR_AUTH_RULES = [
    "rules_version = '2+modules';",
    "import { isAuthenticated } from 'auth';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /items/{id} {',
    '      allow read, write: if isAuthenticated();',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const MODULAR_STDLIB_PATH_RULES = [
    "rules_version = '2+modules';",
    "import { isOwner } from './stdlib/auth.rules';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /items/{id} {',
    '      allow read, write: if isOwner(id);',
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('lowers bundled stdlib imports in firestoreRules() and verifyFixture()', async () => {
    const ruleset = firestoreRules(MODULAR_AUTH_RULES);
    const sim = ruleset.simulate([
      {
        description: 'signed-in user allowed',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/i1',
        auth: { uid: 'u1' },
      },
      {
        description: 'anonymous user denied',
        expectation: 'DENY',
        method: 'get',
        path: 'items/i1',
        auth: null,
      },
    ]);
    expect(sim.passed).toBe(2);
    expect(sim.failed).toBe(0);
    expect(sim.unsupported).toBe(0);
    expect(
      ruleset.lint().filter((issue) => issue.origin === 'parse' || issue.code === 'UNDEFINED_FUNCTION'),
    ).toEqual([]);

    const sb = initializeSandbox();
    setRules(sb, PLAIN_FS_RULES);
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    await setDoc(doc(db, 'items', 'i1'), { title: 'alpha' });

    const fixture = buildVerifyFixture({
      sandbox: sb,
      firestoreRules: PLAIN_FS_RULES,
    });

    const authVerify = await verifyFixture(fixture, {
      services: ['firestore'],
      rules: { firestore: MODULAR_AUTH_RULES },
    });
    expect(authVerify.ok).toBe(true);
    expect(authVerify.services.firestore?.divergences).toEqual([]);

    // Also supports { source } object form and ./stdlib/<key>.rules alias:
    const tightenedVerify = await verifyFixture(fixture, {
      services: ['firestore'],
      rules: { firestore: { source: MODULAR_STDLIB_PATH_RULES } },
    });
    expect(tightenedVerify.ok).toBe(false);
    expect(tightenedVerify.services.firestore?.divergences).toContainEqual(
      expect.objectContaining({
        service: 'firestore',
        kind: 'now-denied',
        path: 'items/i1',
      }),
    );
  });

  it('fails closed on unknown stdlib exports, wrong service declarations, and unresolved relative imports', async () => {
    const badExport = MODULAR_AUTH_RULES.replace('isAuthenticated', 'nonExistentHelper');
    expect(() => firestoreRules(badExport)).toThrow(RulesCompileError);
    await expect(
      verifyFixture(
        buildVerifyFixture({ sandbox: initializeSandbox(), firestoreRules: PLAIN_FS_RULES }),
        { services: ['firestore'], rules: { firestore: badExport } },
      ),
    ).rejects.toThrow(VerifyInputError);

    const unresolvedLocal = MODULAR_AUTH_RULES.replace("'auth'", "'./custom-local.rules'");
    expect(() => firestoreRules(unresolvedLocal)).toThrow(RulesCompileError);
    await expect(
      verifyFixture(
        buildVerifyFixture({ sandbox: initializeSandbox(), firestoreRules: PLAIN_FS_RULES }),
        { services: ['firestore'], rules: { firestore: unresolvedLocal } },
      ),
    ).rejects.toThrow(VerifyInputError);
  });
});

describe('verifyStorage bucket- and method-scoped service_mutation pairing', () => {
  const PNG_128_RULES = [
    "rules_version = '2';",
    'service firebase.storage {',
    '  match /b/{bucket}/o {',
    '    match /items/{id} {',
    '      allow update, delete: if request.auth != null;',
    '      allow create: if request.auth != null',
    "        && request.resource.contentType == 'image/png'",
    '        && request.resource.size == 128;',
    '    }',
    '    match /tagged/{id} {',
    '      allow create: if request.auth != null;',
    "      allow update: if request.auth != null && request.resource.metadata.tag == 'v1';",
    '    }',
    '  }',
    '}',
  ].join('\n');

  const WEBP_256_RULES = [
    "rules_version = '2';",
    'service firebase.storage {',
    '  match /b/{bucket}/o {',
    '    match /items/{id} {',
    '      allow update, delete: if request.auth != null;',
    '      allow create: if request.auth != null',
    "        && request.resource.contentType == 'image/webp'",
    '        && request.resource.size == 256;',
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('does not steal subsequent uploadBytes or updateMetadata mutations after missing-object updateMetadata / deleteObject', async () => {
    const sb = initializeSandbox();
    const st = getStorageSandbox(sb.withAuth({ uid: 'u1', token: {} }), {
      dbName: `storage-pairing-single-${Math.random().toString(36).slice(2, 8)}`,
      rules: PNG_128_RULES,
    });

    await expect(
      updateMetadata(storageRef(st, 'items/avatar.png'), { contentType: 'image/png' }),
    ).rejects.toThrow();

    await uploadBytes(storageRef(st, 'items/avatar.png'), new Uint8Array(128), {
      contentType: 'image/png',
    });
    await uploadBytes(storageRef(st, 'tagged/doc.png'), new Uint8Array(16), {
      contentType: 'image/png',
    });
    await updateMetadata(storageRef(st, 'tagged/doc.png'), {
      customMetadata: { tag: 'v1' },
    });

    // Pure 2-step missing-object updateMetadata followed by uploadBytes (no trailing updateMetadata):
    await expect(
      updateMetadata(storageRef(st, 'items/banner.png'), { contentType: 'image/png' }),
    ).rejects.toThrow();
    await uploadBytes(storageRef(st, 'items/banner.png'), new Uint8Array(128), {
      contentType: 'image/png',
    });

    const fixture = buildVerifyFixture({
      sandbox: sb,
      storageRules: PNG_128_RULES,
    });
    const res = await verifyFixture(fixture, {
      rules: { storage: PNG_128_RULES },
    });
    expect(res.services.storage?.divergences).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('isolates service_mutation pairing across buckets even at identical object paths and concurrent uploads', async () => {
    const sb = initializeSandbox();
    const openCaptureRules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      '      allow read, write: if request.auth != null;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const defSt = getStorageSandbox(sb.withAuth({ uid: 'u1', token: {} }), {
      dbName: `storage-pairing-multi-${Math.random().toString(36).slice(2, 8)}`,
      rules: openCaptureRules,
    });
    const medSt = getStorageSandbox(sb.withAuth({ uid: 'u1', token: {} }), {
      bucket: 'media-bucket',
      rules: openCaptureRules,
    });

    await expect(
      updateMetadata(storageRef(defSt, 'items/avatar.png'), { contentType: 'image/png' }),
    ).rejects.toThrow();

    await Promise.all([
      uploadBytes(storageRef(medSt, 'items/avatar.png'), new Uint8Array(256), {
        contentType: 'image/webp',
      }),
      uploadBytes(storageRef(defSt, 'items/avatar.png'), new Uint8Array(128), {
        contentType: 'image/png',
      }),
    ]);

    const fixture = buildVerifyFixture({
      sandbox: sb,
      storageRules: openCaptureRules,
    });
    const res = await verifyFixture(fixture, {
      rules: {
        storage: PNG_128_RULES,
        storageBuckets: {
          'media-bucket': WEBP_256_RULES,
        },
      },
    });
    expect(res.services.storage?.divergences).toEqual([]);
    expect(res.ok).toBe(true);
  });
});

describe('gs:// Storage bucket URL normalization across sandbox and verifyFixture', () => {
  const BUCKET_PINNED_RULES = [
    "rules_version = '2';",
    'service firebase.storage {',
    '  match /b/{bucket}/o {',
    '    match /items/{id} {',
    "      allow read, write: if request.auth != null && bucket == 'media-bucket';",
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('normalizes gs:// bucket URLs across getStorageSandbox, getAdminStorageSandbox, getStorage, and verifyFixture storageBuckets', async () => {
    const sb = initializeSandbox();
    const authed = sb.withAuth({ uid: 'u1', token: {} });
    const gsHandle = getStorageSandbox(authed, {
      dbName: `storage-gs-bucket-${Math.random().toString(36).slice(2, 8)}`,
      bucket: 'gs://media-bucket',
      rules: BUCKET_PINNED_RULES,
    });
    const slashHandle = getStorageSandbox(authed, { bucket: 'gs://media-bucket/' });
    const bareHandle = getStorageSandbox(authed, { bucket: 'media-bucket' });
    expect(gsHandle).toBe(bareHandle);
    expect(slashHandle).toBe(bareHandle);

    await uploadBytes(storageRef(gsHandle, 'items/doc.txt'), new Uint8Array([7, 8, 9]), {
      contentType: 'text/plain',
    });

    // Admin handle and FirebaseApp getStorage(app, 'gs://media-bucket') share the same normalized bucket:
    const adminGs = getAdminStorageSandbox(sb, { bucket: 'gs://media-bucket' });
    const adminBytes = await getBytes(storageRef(adminGs, 'items/doc.txt'));
    expect(new Uint8Array(adminBytes)).toEqual(new Uint8Array([7, 8, 9]));

    const app = createAppForSandbox(
      sb,
      { projectId: 'demo-proj', storageBucket: 'demo-proj.appspot.com' },
      `storage-gs-app-${Math.random().toString(36).slice(2, 8)}`,
    );
    const appGs = getStorage(app, 'gs://media-bucket');
    expect(storageRef(appGs, 'items/doc.txt').bucket).toBe('media-bucket');

    const fixture = buildVerifyFixture({
      sandbox: sb,
      storageRules: BUCKET_PINNED_RULES,
    });

    const resGsKey = await verifyFixture(fixture, {
      rules: {
        storage: BUCKET_PINNED_RULES,
        storageBuckets: {
          'gs://media-bucket': BUCKET_PINNED_RULES,
        },
      },
    });
    expect(resGsKey.services.storage?.divergences).toEqual([]);
    expect(resGsKey.ok).toBe(true);

    const resBareKey = await verifyFixture(fixture, {
      rules: {
        storage: BUCKET_PINNED_RULES,
        storageBuckets: {
          'media-bucket': BUCKET_PINNED_RULES,
        },
      },
    });
    expect(resBareKey.services.storage?.divergences).toEqual([]);
    expect(resBareKey.ok).toBe(true);

    // Duplicate normalized bucket keys ('gs://media-bucket' and 'media-bucket') fail closed:
    await expect(
      verifyFixture(fixture, {
        rules: {
          storageBuckets: {
            'gs://media-bucket': BUCKET_PINNED_RULES,
            'media-bucket': BUCKET_PINNED_RULES,
          },
        },
      }),
    ).rejects.toThrow(VerifyInputError);
  });
});


