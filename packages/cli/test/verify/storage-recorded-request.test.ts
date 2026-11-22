/**
 * Regression coverage for #1346: `pyric verify` (Storage) replays denied
 * uploads and metadata updates against the recorded `request.resource`,
 * `resource`, granular method, and request time, while falling back to the
 * legacy synthesis with a once-per-run note for older recordings that predate
 * `storageDeniedWrites`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import { EventHistory, primeEventHistory } from 'pyric/sandbox/internal';
import { getStorageSandbox, ref as storageRef, updateMetadata, uploadBytes } from 'pyric/storage';
import { primeStorageDeniedWrites } from 'pyric/storage/internal';

import {
  buildVerifyFixture,
  verifyFixture,
  type PyricVerifyFixture,
} from '../../src/verify/index.js';

let dbSeq = 0;
function nextStorageDb(): string {
  dbSeq += 1;
  return `verify-st-recorded-${Date.now()}-${dbSeq}`;
}

describe('pyric verify Storage recorded request.resource (#1346)', () => {
  it('replays a denied 2048-byte upload against request.resource.size < 1024 without false now-allowed, and reports now-allowed at < 4096', async () => {
    const initialRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      allow create: if request.auth != null && request.resource.size < 1024;
    }
  }
}`;
    const sandbox = initializeSandbox();
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: nextStorageDb(),
      rules: initialRules,
    });

    await expect(
      uploadBytes(storageRef(storage, 'uploads/large.bin'), new Uint8Array(2048), {
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow();

    const fixture = JSON.parse(
      JSON.stringify(buildVerifyFixture({ sandbox, storageRules: initialRules })),
    ) as PyricVerifyFixture;

    const unchanged = await verifyFixture(fixture, { rules: { storage: initialRules } });
    expect(unchanged.ok).toBe(true);
    expect(unchanged.services.storage?.checkedEvents).toBe(1);
    expect(unchanged.services.storage?.divergences).toEqual([]);
    expect(unchanged.services.storage?.notes).toBeUndefined();

    const raisedRules = initialRules.replace(
      'request.resource.size < 1024',
      'request.resource.size < 4096',
    );
    const raised = await verifyFixture(fixture, { rules: { storage: raisedRules } });
    expect(raised.ok).toBe(false);
    expect(raised.services.storage?.divergences).toEqual([
      expect.objectContaining({
        service: 'storage',
        kind: 'now-allowed',
        path: 'uploads/large.bin',
        method: 'create',
      }),
    ]);
  });

  it('replays a denied metadata update with its incoming content headers and metadata rather than reusing stored fields', async () => {
    const initialRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{file} {
      allow create: if request.auth != null;
      allow update: if request.auth != null
        && request.resource.cacheControl == 'private, max-age=0'
        && request.resource.contentLanguage == 'en'
        && request.resource.metadata.stage == 'draft';
    }
  }
}`;
    const sandbox = initializeSandbox();
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: nextStorageDb(),
      rules: initialRules,
    });

    await uploadBytes(storageRef(storage, 'docs/guide.txt'), new Uint8Array(64), {
      contentType: 'text/plain',
      cacheControl: 'private, max-age=0',
      contentLanguage: 'en',
      customMetadata: { stage: 'draft' },
    });

    await expect(
      updateMetadata(storageRef(storage, 'docs/guide.txt'), {
        cacheControl: 'public, max-age=3600',
        contentLanguage: 'es',
        customMetadata: { stage: 'published' },
      }),
    ).rejects.toThrow();

    const fixture = JSON.parse(
      JSON.stringify(buildVerifyFixture({ sandbox, storageRules: initialRules })),
    ) as PyricVerifyFixture;

    const unchanged = await verifyFixture(fixture, { rules: { storage: initialRules } });
    expect(unchanged.ok).toBe(true);
    expect(unchanged.services.storage?.checkedEvents).toBe(2);
    expect(unchanged.services.storage?.divergences).toEqual([]);
    expect(unchanged.services.storage?.notes).toBeUndefined();

    const loosenedUpdateRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{file} {
      allow create: if request.auth != null;
      allow update: if request.auth != null
        && request.resource.cacheControl == 'public, max-age=3600'
        && request.resource.contentLanguage == 'es'
        && request.resource.metadata.stage == 'published';
    }
  }
}`;
    const loosened = await verifyFixture(fixture, { rules: { storage: loosenedUpdateRules } });
    expect(loosened.ok).toBe(false);
    expect(loosened.services.storage?.divergences).toEqual([
      expect.objectContaining({
        service: 'storage',
        kind: 'now-allowed',
        path: 'docs/guide.txt',
        method: 'update',
      }),
    ]);
  });

  it('preserves request.time and worker-hydrated denied writes across sandbox re-hydration', async () => {
    const timeGatedRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /embargo/{file} {
      allow create: if request.time >= timestamp.date(2027, 1, 1) && request.resource.size <= 2048;
    }
  }
}`;
    const sandbox = initializeSandbox();
    getClock(sandbox).set(Date.parse('2026-06-15T12:00:00.000Z'));
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: nextStorageDb(),
      rules: timeGatedRules,
    });

    await expect(
      uploadBytes(storageRef(storage, 'embargo/release.bin'), new Uint8Array(1500)),
    ).rejects.toThrow();

    const initialFixture = JSON.parse(
      JSON.stringify(buildVerifyFixture({ sandbox, storageRules: timeGatedRules })),
    ) as PyricVerifyFixture;

    // Hydrate a fresh worker sandbox from captured event history + storageDeniedWrites and re-export.
    const workerSandbox = initializeSandbox();
    const retained = new EventHistory();
    for (const event of initialFixture.events) retained.append(event);
    primeEventHistory(workerSandbox, retained.snapshot());
    primeStorageDeniedWrites(workerSandbox, initialFixture.storageDeniedWrites);
    const workerFixture = JSON.parse(
      JSON.stringify(buildVerifyFixture({ sandbox: workerSandbox, storageRules: timeGatedRules })),
    ) as PyricVerifyFixture;

    const sameRules = await verifyFixture(workerFixture, { rules: { storage: timeGatedRules } });
    expect(sameRules.ok).toBe(true);
    expect(sameRules.services.storage?.divergences).toEqual([]);

    const earlierEmbargo = timeGatedRules.replace(
      'timestamp.date(2027, 1, 1)',
      'timestamp.date(2026, 1, 1)',
    );
    const opened = await verifyFixture(workerFixture, { rules: { storage: earlierEmbargo } });
    expect(opened.ok).toBe(false);
    expect(opened.services.storage?.divergences).toEqual([
      expect.objectContaining({
        service: 'storage',
        kind: 'now-allowed',
        path: 'embargo/release.bin',
        method: 'create',
      }),
    ]);
  });

  it('falls back to legacy derivation on older recordings lacking storageDeniedWrites and emits one note per run', async () => {
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /legacy/{file} {
      allow create: if request.resource.size > 0 && request.resource.size < 100;
    }
  }
}`;
    const sandbox = initializeSandbox();
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: nextStorageDb(),
      rules,
    });

    await expect(
      uploadBytes(storageRef(storage, 'legacy/first.bin'), new Uint8Array(500)),
    ).rejects.toThrow();
    await expect(
      uploadBytes(storageRef(storage, 'legacy/second.bin'), new Uint8Array(800)),
    ).rejects.toThrow();

    const legacyFixture = JSON.parse(
      JSON.stringify(buildVerifyFixture({ sandbox, storageRules: rules })),
    ) as PyricVerifyFixture;
    delete legacyFixture.storageDeniedWrites;

    const result = await verifyFixture(legacyFixture, { rules: { storage: rules } });
    expect(result.ok).toBe(true);
    expect(result.services.storage?.checkedEvents).toBe(2);
    expect(result.services.storage?.notes).toHaveLength(1);
    expect(result.services.storage?.notes?.[0]).toContain('older recording');
    expect(result.services.storage?.engines?.sandbox?.notes).toEqual(
      result.services.storage?.notes,
    );
  });
});
