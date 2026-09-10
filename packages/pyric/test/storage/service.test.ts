/**
 * Slice 4 — Service factory + Sandbox integration.
 *
 * Verifies the caching invariants `getStorage` advertises and the
 * routing it does for `Sandbox` vs `SandboxContext` inputs. The
 * underlying IDB backend is shared per Sandbox so future read/write
 * ops (Slice 5) see one another's data across contexts; this slice
 * confirms that via the internal `getStorageService` accessor.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from '../../src/app/internal.js';
import { getStorage, ref as storageRef, uploadBytes } from '../../src/storage/index.js';
import {
  getStorageCrossServiceIam,
  getStorageSandbox,
  getStorageService,
  replaceCrossServiceIam,
  replaceStorageRules,
  targetOf,
} from '../../src/storage/service.js';
import { storageFirestoreLookup } from '../../src/storage/enforce.js';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';
import { getStorageRulesResolution } from '../../src/storage/internal.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('getStorageSandbox', () => {
  it('getStorage accepts a sandbox app and ignores Firebase bucket routing', () => {
    const sandbox = initializeSandbox({});
    const app = createAppForSandbox(
      sandbox,
      { projectId: 'storage-test' },
      `storage-app-${Math.random().toString(36).slice(2, 10)}`,
    );
    const storage = getStorage(app, 'gs://production-bucket');

    expect(targetOf(storage).bucket).toBe('pyric-default');
  });

  it('accepts a bare Sandbox and wires up an anonymous context', () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, { dbName: uniqueDbName('bare-sandbox') });
    const t = targetOf(storage);
    if (t.kind !== 'sandbox') throw new Error('expected sandbox target');
    expect(t.sandbox).toBe(sandbox);
    expect(t.context.auth).toBe(null);
    expect(t.bucket).toBe('pyric-default');
  });

  it('accepts a SandboxContext and binds the handle to it', () => {
    const sandbox = initializeSandbox({});
    const ctx = sandbox.withAuth({ uid: 'alice' });
    const storage = getStorageSandbox(ctx, { dbName: uniqueDbName('context') });
    const t = targetOf(storage);
    if (t.kind !== 'sandbox') throw new Error('expected sandbox target');
    expect(t.context).toBe(ctx);
    expect(t.context.auth).toEqual({ uid: 'alice' });
  });

  it('returns the same handle for repeated calls on the same context', () => {
    const sandbox = initializeSandbox({});
    const ctx = sandbox.withAuth({ uid: 'alice' });
    const dbName = uniqueDbName('idempotent');
    const a = getStorageSandbox(ctx, { dbName });
    const b = getStorageSandbox(ctx, { dbName });
    expect(a).toBe(b);
  });

  it('ST-B3: returns the same handle for repeated bare-Sandbox calls', () => {
    // `Sandbox.withAuth(null)` mints a fresh context each call, so
    // without the bare-Sandbox cache this returned two handles. The
    // docstring + COMPAT claim identity-stability per Sandbox.
    const sandbox = initializeSandbox({});
    const a = getStorageSandbox(sandbox, { dbName: uniqueDbName('bare-stable') });
    const b = getStorageSandbox(sandbox);
    expect(a).toBe(b);
    const ta = targetOf(a);
    const tb = targetOf(b);
    if (ta.kind !== 'sandbox' || tb.kind !== 'sandbox') throw new Error('expected sandbox targets');
    expect(ta.context).toBe(tb.context);
  });

  it('returns different handles for different contexts on the same sandbox', () => {
    const sandbox = initializeSandbox({});
    const alice = sandbox.withAuth({ uid: 'alice' });
    const bob = sandbox.withAuth({ uid: 'bob' });
    const dbName = uniqueDbName('two-contexts');
    const aliceStorage = getStorageSandbox(alice, { dbName });
    const bobStorage = getStorageSandbox(bob, { dbName });
    expect(aliceStorage).not.toBe(bobStorage);
    const at = targetOf(aliceStorage);
    const bt = targetOf(bobStorage);
    if (at.kind !== 'sandbox' || bt.kind !== 'sandbox') throw new Error('expected sandbox targets');
    expect(at.context).toBe(alice);
    expect(bt.context).toBe(bob);
  });

  it('shares the underlying StorageService across contexts on the same sandbox', async () => {
    const sandbox = initializeSandbox({});
    const alice = sandbox.withAuth({ uid: 'alice' });
    const bob = sandbox.withAuth({ uid: 'bob' });
    const dbName = uniqueDbName('shared-service');

    const aliceStorage = getStorageSandbox(alice, { dbName });
    const bobStorage = getStorageSandbox(bob, { dbName });

    const [aliceService, bobService] = await Promise.all([
      getStorageService(aliceStorage),
      getStorageService(bobStorage),
    ]);
    expect(aliceService).toBe(bobService);
  });

  it('isolates services across independent Sandbox instances', async () => {
    const a = initializeSandbox({});
    const b = initializeSandbox({});
    const aStorage = getStorageSandbox(a, { dbName: uniqueDbName('iso-a') });
    const bStorage = getStorageSandbox(b, { dbName: uniqueDbName('iso-b') });
    const [aService, bService] = await Promise.all([
      getStorageService(aStorage),
      getStorageService(bStorage),
    ]);
    expect(aService).not.toBe(bService);
  });

  it("dbName only takes effect on the sandbox's first getStorage call", async () => {
    // The cache is keyed by Sandbox, so options.dbName supplied on a
    // SECOND call (after the service is already constructed) is
    // ignored. Verify: open one backend with dbName 'first', write a
    // value, then 'open' again with dbName 'second' — the same
    // backend is returned and the original value is still there.
    const sandbox = initializeSandbox({});
    const first = uniqueDbName('first');
    const second = uniqueDbName('second');

    const handleA = getStorageSandbox(sandbox, { dbName: first });
    const serviceA = await getStorageService(handleA);
    await serviceA.backend.put(
      'sessions/s1.json',
      new Blob(['probe']),
      {
        fullPath: 'sessions/s1.json',
        name: 's1.json',
        bucket: 'pyric-default',
        generation: '1',
        metageneration: '1',
        timeCreated: '2026-05-10T00:00:00.000Z',
        updated: '2026-05-10T00:00:00.000Z',
        size: 5,
      },
    );

    const handleB = getStorageSandbox(sandbox, { dbName: second });
    const serviceB = await getStorageService(handleB);
    expect(serviceB).toBe(serviceA);
    expect(await serviceB.backend.getBlob('sessions/s1.json')).toBeDefined();
  });

  it('records the bucket value on the handle (round-trips even without enforcement)', () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      bucket: 'custom-bucket',
      dbName: uniqueDbName('custom-bucket'),
    });
    const t = targetOf(storage);
    if (t.kind !== 'sandbox') throw new Error('expected sandbox target');
    expect(t.bucket).toBe('custom-bucket');
  });

  it('rejects an object that was not produced by a factory', () => {
    const fake = Object.freeze({
      sandbox: undefined,
      context: undefined,
      bucket: 'fake',
    } as unknown as ReturnType<typeof getStorageSandbox>);
    expect(() => getStorageService(fake)).toThrow(/not a FirebaseStorage handle/);
  });

  it('retains an immutable module-resolution descriptor for assurance', () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueDbName('rules-resolution'),
      rules: `rules_version = '2+modules';
import { isAuthenticated } from './stdlib/auth.rules';
import { hasRole } from './stdlib/membership.rules';
import { sizeAtMost } from './stdlib/storage/uploads.rules';
service firebase.storage {
  match /b/{bucket}/o {
    match /{file} {
      allow create: if isAuthenticated() && sizeAtMost(10)
        && hasRole(firestore
          .get(/databases/(default)/documents/members/$(request.auth.uid)).data, 'editor');
    }
  }
}`,
    });
    const resolution = getStorageRulesResolution(storage);
    expect(resolution).toMatchObject({
      targetService: 'firebase.storage',
      modules: [
        './stdlib/auth.rules',
        './stdlib/membership.rules',
        './stdlib/storage/uploads.rules',
      ],
      evidenceIds: ['storage-rules#125', 'storage-rules#131', 'storage-rules#132'],
    });
    expect(resolution?.source).toContain("rules_version = '2';");
    expect(resolution?.source).not.toContain('import ');
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution?.modules)).toBe(true);
  });

  it('ignores module-version text inside comments on ordinary v2 rules', () => {
    const rules = `rules_version = '2';
// Documentation example only: rules_version = '2+modules';
service firebase.storage {
  match /b/{bucket}/o { match /{file} { allow read: if true; } }
}`;
    const storage = getStorageSandbox(initializeSandbox({}), {
      dbName: uniqueDbName('commented-module-version'),
      rules,
    });

    expect(getStorageRulesResolution(storage)).toMatchObject({ source: rules, modules: [] });
  });

  it('resolves a parser-valid commented module-version declaration', () => {
    const storage = getStorageSandbox(initializeSandbox({}), {
      dbName: uniqueDbName('commented-version-declaration'),
      rules: `rules_version /* syntax comment */ = '2+modules';
import { isAuthenticated } from 'auth';
service firebase.storage {
  match /b/{bucket}/o { match /{file} { allow read: if isAuthenticated(); } }
}`,
    });
    const resolution = getStorageRulesResolution(storage);

    expect(resolution?.modules).toEqual(['auth']);
    expect(resolution?.source).toContain("rules_version = '2';");
    expect(resolution?.source).not.toContain('import ');
  });

});

describe('replaceStorageRules', () => {
  const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileName} {
      allow read, write: if true;
    }
  }
}
`;
  const SIGNED_IN_ONLY_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileName} {
      allow read, write: if request.auth != null;
    }
  }
}
`;

  it('replaces the ruleset an already open service enforces', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueDbName('replace-rules'),
      rules: OPEN_RULES,
    });
    await getStorageService(storage);

    await replaceStorageRules(sandbox, SIGNED_IN_ONLY_RULES);

    const service = await getStorageService(storage);
    const installed = service.rules;
    if (installed === null) throw new Error('expected a ruleset in force');
    const evaluated = evaluateStorageRules(installed, {
      request: { auth: null, method: 'get', path: 'b/pyric-default/o/uploads/report.pdf' },
      resource: null,
    });

    expect(evaluated.allowed).toBe(false);
    expect(getStorageRulesResolution(storage)?.source).toBe(SIGNED_IN_ONLY_RULES);
  });

  it('opens a service that is not open yet with the supplied rules', async () => {
    const sandbox = initializeSandbox({});
    await replaceStorageRules(sandbox, OPEN_RULES);
    const storage = getStorageSandbox(sandbox);
    await getStorageService(storage);

    expect(getStorageRulesResolution(storage)?.source).toBe(OPEN_RULES);
  });

  it('leaves the ruleset in force when the new source does not parse', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueDbName('reject-rules'),
      rules: OPEN_RULES,
    });
    await getStorageService(storage);

    let thrown: unknown = null;
    try {
      await replaceStorageRules(sandbox, 'not rules at all {');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeNull();
    expect(getStorageRulesResolution(storage)?.source).toBe(OPEN_RULES);
  });

  it('still refuses a late differing rules option on the factory', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueDbName('guard-holds'),
      rules: OPEN_RULES,
    });
    await getStorageService(storage);

    expect(() => getStorageSandbox(sandbox, { rules: SIGNED_IN_ONLY_RULES })).toThrow(
      /honored only on the FIRST storage/,
    );
  });
});

describe('replaceCrossServiceIam', () => {
  const FLAGGED_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileName} {
      allow read, write: if firestore.exists(/databases/(default)/documents/flags/enabled);
    }
  }
}
`;

  /** A sandbox holding the document the rule looks up, and its storage handle. */
  function openFlaggedStorage(label: string) {
    const sandbox = initializeSandbox({});
    sandbox.admin.setDocument('flags/enabled', { on: true });
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueDbName(label),
      rules: FLAGGED_RULES,
    });
    return { sandbox, storage };
  }

  it('reports the mode an open service was opened with', async () => {
    const { sandbox, storage } = openFlaggedStorage('iam-read');
    await getStorageService(storage);
    expect(getStorageCrossServiceIam(sandbox)).toBe('granted');
  });

  it('reports granted for a sandbox whose storage service is not open yet', () => {
    const sandbox = initializeSandbox({});
    expect(getStorageCrossServiceIam(sandbox)).toBe('granted');
  });

  it('flips the mode an already open service enforces', async () => {
    const { sandbox, storage } = openFlaggedStorage('iam-flip');
    const bytes = Uint8Array.from([1, 2, 3]);
    await uploadBytes(storageRef(storage, 'uploads/report.json'), bytes);

    await replaceCrossServiceIam(sandbox, 'denied');

    expect(getStorageCrossServiceIam(sandbox)).toBe('denied');
    await expect(
      uploadBytes(storageRef(storage, 'uploads/second.json'), bytes),
    ).rejects.toThrow(/firebaserules\.firestoreServiceAgent/);

    await replaceCrossServiceIam(sandbox, 'granted');
    await uploadBytes(storageRef(storage, 'uploads/third.json'), bytes);
  });

  it('opens the service on the named mode when nothing has opened it yet', async () => {
    const sandbox = initializeSandbox({});
    await replaceCrossServiceIam(sandbox, 'denied');
    expect(getStorageCrossServiceIam(sandbox)).toBe('denied');
  });

  it('builds a lookup that reads the sandbox under granted and fails under denied', () => {
    const sandbox = initializeSandbox({});
    sandbox.admin.setDocument('flags/enabled', { on: true });

    // The evaluator hands the lookup a store path, having already stripped the
    // `/databases/(default)/documents/` prefix off the rule's path literal.
    const granted = storageFirestoreLookup(sandbox, 'granted');
    expect(granted.exists('flags/enabled')).toBe(true);
    expect(granted.get('flags/enabled')).toEqual({ on: true });

    const denied = storageFirestoreLookup(sandbox, 'denied');
    expect(() => denied.exists('flags/enabled')).toThrow(
      /firebaserules\.firestoreServiceAgent/,
    );
  });
});
