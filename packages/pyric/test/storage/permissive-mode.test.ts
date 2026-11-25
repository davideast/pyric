/**
 * Storage service permissive mode and undeployed-bucket runtime notices (#1528).
 *
 * Covers:
 * 1. Standalone Storage service `defaultPolicy: 'allow'` via `getStorageSandbox`,
 *    `getStorageDefaultPolicy`, and `setStorageDefaultPolicy` (including after
 *    `replaceStorageRules(sandbox, null)` or `pruneStorageBucketRules`).
 * 2. First-use `console.warn(undeployedBucketNotice(bucket, policy))` once per
 *    undeployed non-default bucket when `firebase.json` per-bucket rules are active.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  initializeSandbox,
  type SandboxEvent,
  type SandboxOperationEvent,
} from 'pyric/sandbox';
import { createAppForSandbox } from '../../src/app/internal.js';
import {
  deleteObject,
  getBytes,
  getMetadata,
  getStorage,
  getStorageSandbox,
  listAll,
  ref,
  uploadBytes,
} from '../../src/storage/index.js';
import {
  getAdminStorageSandbox,
  getStorageDefaultPolicy,
  getStorageService,
  lockUndeployedStorageBuckets,
  pruneStorageBucketRules,
  replaceStorageRules,
  setStorageDefaultPolicy,
  targetOf,
  undeployedBucketNotice,
} from '../../src/storage/internal.js';
import { storageRulesInForce } from '../../src/storage/service.js';

const DENY_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} {
      allow read, write: if false;
    }
  }
}`;

const OPEN_ALL = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} {
      allow read, write: if true;
    }
  }
}`;

const PAYLOAD = new TextEncoder().encode('permissive-payload');

function uniqueName(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

async function captureBucketNotices(run: () => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('pyric: Storage bucket ')) {
      captured.push(line);
    } else {
      originalWarn(...args);
    }
  };
  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }
  return captured;
}

describe('Storage service defaultPolicy (#1528)', () => {
  it('defaults to deny and opens all client operations when opened with defaultPolicy allow', async () => {
    const denySandbox = initializeSandbox({});
    expect(getStorageDefaultPolicy(denySandbox)).toBe('deny');
    const denyStorage = getStorageSandbox(denySandbox, { dbName: uniqueName('default-deny') });
    await expect(uploadBytes(ref(denyStorage, 'items/a.txt'), PAYLOAD)).rejects.toMatchObject({
      code: 'storage/unauthorized',
    });

    const allowSandbox = initializeSandbox({});
    const events: SandboxEvent[] = [];
    allowSandbox.onEvent((event) => events.push(event));
    const allowStorage = getStorageSandbox(allowSandbox, {
      dbName: uniqueName('default-allow'),
      defaultPolicy: 'allow',
    });
    expect(getStorageDefaultPolicy(allowSandbox)).toBe('allow');

    await uploadBytes(ref(allowStorage, 'items/a.txt'), PAYLOAD, { contentType: 'text/plain' });
    const meta = await getMetadata(ref(allowStorage, 'items/a.txt'));
    expect(meta.size).toBe(PAYLOAD.byteLength);
    const bytes = await getBytes(ref(allowStorage, 'items/a.txt'));
    expect(new Uint8Array(bytes)).toEqual(PAYLOAD);
    const listed = await listAll(ref(allowStorage, 'items'));
    expect(listed.items).toHaveLength(1);
    await deleteObject(ref(allowStorage, 'items/a.txt'));

    const scopedBucket = getStorageSandbox(allowSandbox, { bucket: 'extra-bucket' });
    await uploadBytes(ref(scopedBucket, 'items/b.txt'), PAYLOAD);
    expect((await getMetadata(ref(scopedBucket, 'items/b.txt'))).size).toBe(PAYLOAD.byteLength);

    const ops = events.filter((event): event is SandboxOperationEvent => event.kind === 'operation');
    expect(ops.length).toBeGreaterThanOrEqual(5);
    expect(ops[0]).toMatchObject({
      service: 'storage',
      result: 'allow',
      rulesDisposition: { kind: 'not-evaluated', reason: 'no-rules' },
      detail: { defaultPolicy: 'allow' },
    });
    expect(ops[0]?.rules).toBeUndefined();
  });

  it('toggles between deny and allow via setStorageDefaultPolicy and respects explicit rules while installed', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, { dbName: uniqueName('toggle-policy') });
    const scoped = getStorageSandbox(sandbox, { bucket: 'scoped-bucket' });

    await expect(uploadBytes(ref(storage, 'a.txt'), PAYLOAD)).rejects.toMatchObject({
      code: 'storage/unauthorized',
    });

    await setStorageDefaultPolicy(sandbox, 'allow');
    expect(getStorageDefaultPolicy(sandbox)).toBe('allow');
    await uploadBytes(ref(storage, 'a.txt'), PAYLOAD);
    await uploadBytes(ref(scoped, 'b.txt'), PAYLOAD);

    await replaceStorageRules(sandbox, DENY_ALL);
    await expect(uploadBytes(ref(storage, 'c.txt'), PAYLOAD)).rejects.toMatchObject({
      code: 'storage/unauthorized',
    });

    await replaceStorageRules(sandbox, null);
    await uploadBytes(ref(storage, 'c.txt'), PAYLOAD);

    await setStorageDefaultPolicy(sandbox, 'deny');
    expect(getStorageDefaultPolicy(sandbox)).toBe('deny');
    await expect(uploadBytes(ref(storage, 'd.txt'), PAYLOAD)).rejects.toMatchObject({
      code: 'storage/unauthorized',
    });
    await expect(uploadBytes(ref(scoped, 'e.txt'), PAYLOAD)).rejects.toMatchObject({
      code: 'storage/unauthorized',
    });
  });

  it('adopts defaultPolicy when admin opened the sandbox first and rejects differing late defaultPolicy', async () => {
    const sandbox = initializeSandbox({});
    const admin = getAdminStorageSandbox(sandbox, { dbName: uniqueName('admin-first-policy') });
    await uploadBytes(ref(admin, 'seeded.txt'), PAYLOAD);

    const client = getStorageSandbox(sandbox, { defaultPolicy: 'allow' });
    expect(getStorageDefaultPolicy(sandbox)).toBe('allow');
    expect(new Uint8Array(await getBytes(ref(client, 'seeded.txt')))).toEqual(PAYLOAD);

    expect(() => getStorageSandbox(sandbox, { defaultPolicy: 'deny' })).toThrow(
      /already open with a different defaultPolicy mode/,
    );
  });

  it('retains service permissive mode when pruneStorageBucketRules clears the last named bucket', async () => {
    const sandbox = initializeSandbox({});
    getStorageSandbox(sandbox, {
      dbName: uniqueName('prune-permissive'),
      defaultPolicy: 'allow',
    });
    lockUndeployedStorageBuckets(sandbox, 'allow');
    await replaceStorageRules(sandbox, DENY_ALL, { bucket: 'locked-bucket' });

    const app = createAppForSandbox(
      sandbox,
      { projectId: 'demo-app', storageBucket: 'demo-app.appspot.com' },
      uniqueName('app'),
    );
    await expect(
      uploadBytes(ref(getStorage(app, 'gs://locked-bucket'), 'a.txt'), PAYLOAD),
    ).rejects.toMatchObject({ code: 'storage/unauthorized' });

    pruneStorageBucketRules(sandbox, new Set());
    await uploadBytes(ref(getStorage(app), 'default.txt'), PAYLOAD);
    await uploadBytes(ref(getStorage(app, 'gs://locked-bucket'), 'now-open.txt'), PAYLOAD);
  });

  it('gives explicit lockUndeployedStorageBuckets deny precedence over service defaultPolicy allow and updates synchronously on allow -> deny', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueName('explicit-deny-precedence'),
      defaultPolicy: 'allow',
    });
    const service = await getStorageService(storage);
    expect(storageRulesInForce(service, targetOf(storage)).kind).toBe('open');

    // Synchronous allow -> deny transition before the async service mutation settles:
    const pendingFlip = setStorageDefaultPolicy(sandbox, 'deny');
    expect(storageRulesInForce(service, targetOf(storage)).kind).toBe('none');
    await pendingFlip;

    // Restore service defaultPolicy to allow, then explicitly lock undeployed buckets with deny:
    await setStorageDefaultPolicy(sandbox, 'allow');
    lockUndeployedStorageBuckets(sandbox, 'deny');
    await replaceStorageRules(sandbox, OPEN_ALL, { bucket: 'declared-open' });

    const app = createAppForSandbox(
      sandbox,
      { projectId: 'demo-app', storageBucket: 'demo-app.appspot.com' },
      uniqueName('precedence-app'),
    );
    const notices = await captureBucketNotices(async () => {
      await uploadBytes(ref(getStorage(app, 'gs://declared-open'), 'ok.txt'), PAYLOAD);
      await expect(
        uploadBytes(ref(getStorage(app, 'gs://explicitly-locked'), 'nope.txt'), PAYLOAD),
      ).rejects.toMatchObject({ code: 'storage/unauthorized' });
    });
    expect(notices).toEqual([undeployedBucketNotice('explicitly-locked', 'deny')]);
  });
});

describe('undeployedBucketNotice (#1528)', () => {
  it('formats allow and deny notices matching RTDB undeployedInstanceNotice structure', () => {
    expect(undeployedBucketNotice('media-bucket', 'allow')).toBe(
      'pyric: Storage bucket "media-bucket" has no rules in firebase.json; permissive mode allows every client operation. Add {"bucket": "media-bucket", "rules": "<file>"} to the storage array.',
    );
    expect(undeployedBucketNotice('media-bucket', 'deny')).toBe(
      'pyric: Storage bucket "media-bucket" has no rules in firebase.json; it denies every client operation. Add {"bucket": "media-bucket", "rules": "<file>"} to the storage array.',
    );
  });

  it('logs once per undeployed non-default bucket under deny and allow policies, never for default or deployed buckets', async () => {
    const denySandbox = initializeSandbox({});
    getStorageSandbox(denySandbox, { dbName: uniqueName('notice-deny') });
    lockUndeployedStorageBuckets(denySandbox, 'deny');
    await replaceStorageRules(denySandbox, OPEN_ALL, { bucket: 'declared-bucket' });
    const denyApp = createAppForSandbox(
      denySandbox,
      { projectId: 'demo-app', storageBucket: 'demo-app.appspot.com' },
      uniqueName('deny-app'),
    );

    const denyNotices = await captureBucketNotices(async () => {
      await expect(uploadBytes(ref(getStorage(denyApp), 'a.txt'), PAYLOAD)).rejects.toMatchObject({
        code: 'storage/unauthorized',
      });
      await uploadBytes(ref(getStorage(denyApp, 'gs://declared-bucket'), 'a.txt'), PAYLOAD);
      const undeclared = getStorage(denyApp, 'gs://undeclared-bucket');
      await expect(uploadBytes(ref(undeclared, 'a.txt'), PAYLOAD)).rejects.toMatchObject({
        code: 'storage/unauthorized',
      });
      await expect(getMetadata(ref(undeclared, 'a.txt'))).rejects.toMatchObject({
        code: 'storage/unauthorized',
      });
    });
    expect(denyNotices).toEqual([undeployedBucketNotice('undeclared-bucket', 'deny')]);

    const allowSandbox = initializeSandbox({});
    getStorageSandbox(allowSandbox, {
      dbName: uniqueName('notice-allow'),
      defaultPolicy: 'allow',
    });
    lockUndeployedStorageBuckets(allowSandbox, 'allow');
    await replaceStorageRules(allowSandbox, DENY_ALL, { bucket: 'declared-locked' });
    const allowApp = createAppForSandbox(
      allowSandbox,
      { projectId: 'demo-app', storageBucket: 'demo-app.appspot.com' },
      uniqueName('allow-app'),
    );

    const allowNotices = await captureBucketNotices(async () => {
      await uploadBytes(ref(getStorage(allowApp), 'a.txt'), PAYLOAD);
      await expect(
        uploadBytes(ref(getStorage(allowApp, 'gs://declared-locked'), 'a.txt'), PAYLOAD),
      ).rejects.toMatchObject({ code: 'storage/unauthorized' });
      const undeclared = getStorage(allowApp, 'gs://undeclared-open');
      await uploadBytes(ref(undeclared, 'a.txt'), PAYLOAD);
      await getBytes(ref(undeclared, 'a.txt'));
    });
    expect(allowNotices).toEqual([undeployedBucketNotice('undeclared-open', 'allow')]);
  });

  it('does not log firebase.json notices on a standalone sandbox that never deployed per-bucket rules', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueName('standalone-no-notice'),
      defaultPolicy: 'allow',
      bucket: 'standalone-bucket',
    });
    const notices = await captureBucketNotices(async () => {
      await uploadBytes(ref(storage, 'a.txt'), PAYLOAD);
    });
    expect(notices).toEqual([]);
  });
});
