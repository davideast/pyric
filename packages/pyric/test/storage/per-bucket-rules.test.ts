/**
 * Each Storage bucket enforces the rules deployed to it (#1313, ST-H2-2).
 * Production keeps one release per bucket (`firebase.storage/<bucket>`), so
 * a bucket enforces only its own file, and a bucket nothing deploys to is
 * locked, as production creates a bucket.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, type LocalSandbox, type SandboxEvent, type SandboxOperationEvent } from 'pyric/sandbox';
import { initializeApp } from '../../src/app/index.js';
import {
  bindAppRegistrySandbox,
  createAppForSandbox,
  resetAppRegistryForTests,
} from '../../src/app/internal.js';
import { getBytes, getMetadata, getStorage, ref, uploadBytes } from '../../src/storage/index.js';
import { pruneStorageBucketRules } from '../../src/storage/internal.js';
import {
  getStorageSandbox,
  lockUndeployedStorageBuckets,
  replaceStorageRules,
} from '../../src/storage/service.js';

const DEFAULT_BUCKET = 'demo-app.appspot.com';
const MEDIA_BUCKET = 'media-bucket';

const OPEN = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} {
      allow read, write: if true;
    }
  }
}`;

const SIGNED_IN = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const BYTES = new TextEncoder().encode('x');

function uniqueName(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function freshSandbox(): LocalSandbox {
  const sandbox = initializeSandbox({});
  getStorageSandbox(sandbox, { dbName: uniqueName('per-bucket') });
  return sandbox;
}

/** The app's storage on its default bucket, and on `gs://<bucket>`. */
function appStorage(sandbox: LocalSandbox, bucketUrl?: string) {
  const app = createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: DEFAULT_BUCKET }, uniqueName('app'));
  return getStorage(app, bucketUrl);
}

async function uploadOutcome(storage: ReturnType<typeof getStorage>, path: string): Promise<string> {
  try {
    await uploadBytes(ref(storage, path), BYTES);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

/** The hunt's repro: media.rules allows everything, storage.rules requires sign-in. */
async function deployHuntRules(sandbox: LocalSandbox): Promise<void> {
  lockUndeployedStorageBuckets(sandbox);
  await replaceStorageRules(sandbox, OPEN, { bucket: MEDIA_BUCKET });
  await replaceStorageRules(sandbox, SIGNED_IN, { bucket: DEFAULT_BUCKET });
}

describe('per-bucket Storage rules', () => {
  it('two buckets with different rules each enforce their own, in page', async () => {
    const sandbox = freshSandbox();
    await deployHuntRules(sandbox);
    expect(await uploadOutcome(appStorage(sandbox), 'a.txt')).toBe('storage/unauthorized');
    expect(await uploadOutcome(appStorage(sandbox, `gs://${MEDIA_BUCKET}`), 'a.txt')).toBe('ok');
  });

  it('keeps a bucket URL handle objects apart from the default bucket, in page', async () => {
    const sandbox = freshSandbox();
    lockUndeployedStorageBuckets(sandbox);
    await replaceStorageRules(sandbox, OPEN, { bucket: MEDIA_BUCKET });
    await replaceStorageRules(sandbox, OPEN, { bucket: DEFAULT_BUCKET });
    await uploadBytes(ref(appStorage(sandbox, `gs://${MEDIA_BUCKET}`), 'only-media.txt'), BYTES);
    await expect(getMetadata(ref(appStorage(sandbox), 'only-media.txt'))).rejects.toMatchObject({
      code: 'storage/object-not-found',
    });
    const media = await getMetadata(ref(appStorage(sandbox, `gs://${MEDIA_BUCKET}`), 'only-media.txt'));
    expect(media.bucket).toBe(MEDIA_BUCKET);
  });

  it('two buckets with different rules each enforce their own, on bucket-scoped handles', async () => {
    const sandbox = freshSandbox();
    await deployHuntRules(sandbox);
    const media = getStorageSandbox(sandbox, { bucket: MEDIA_BUCKET });
    expect(await uploadOutcome(media, 'a.txt')).toBe('ok');
  });

  it('locks a bucket no entry deploys to', async () => {
    const sandbox = freshSandbox();
    await deployHuntRules(sandbox);
    const other = appStorage(sandbox, 'gs://other-bucket');
    expect(await uploadOutcome(other, 'a.txt')).toBe('storage/unauthorized');
    await expect(uploadBytes(ref(other, 'b.txt'), BYTES)).rejects.toThrow(
      'Storage bucket "other-bucket" has no rules deployed in firebase.json',
    );
    const scoped = getStorageSandbox(sandbox, { bucket: 'other-bucket' });
    expect(await uploadOutcome(scoped, 'a.txt')).toBe('storage/unauthorized');
  });

  it('names the bucket in a rules denial', async () => {
    const sandbox = freshSandbox();
    await deployHuntRules(sandbox);
    await replaceStorageRules(sandbox, SIGNED_IN, { bucket: MEDIA_BUCKET });
    const denial = await uploadBytes(ref(appStorage(sandbox, `gs://${MEDIA_BUCKET}`), 'a.txt'), BYTES).catch(
      (error: unknown) => error as { code?: string; message?: string },
    );
    expect(denial).toMatchObject({ code: 'storage/unauthorized' });
    expect((denial as { message?: string }).message).toContain(`"${MEDIA_BUCKET}"`);
    const defaultDenial = await uploadBytes(ref(appStorage(sandbox), 'a.txt'), BYTES).catch(
      (error: unknown) => error as { message?: string },
    );
    expect((defaultDenial as { message?: string }).message).toContain(`"${DEFAULT_BUCKET}"`);
  });

  it('replaceStorageRules with a bucket leaves the other buckets alone', async () => {
    const sandbox = freshSandbox();
    await deployHuntRules(sandbox);
    await replaceStorageRules(sandbox, SIGNED_IN, { bucket: MEDIA_BUCKET });
    expect(await uploadOutcome(appStorage(sandbox, `gs://${MEDIA_BUCKET}`), 'a.txt')).toBe('storage/unauthorized');
    await replaceStorageRules(sandbox, OPEN, { bucket: DEFAULT_BUCKET });
    expect(await uploadOutcome(appStorage(sandbox), 'a.txt')).toBe('ok');
    expect(await uploadOutcome(appStorage(sandbox, `gs://${MEDIA_BUCKET}`), 'b.txt')).toBe('storage/unauthorized');
  });

  it('gives the unnamed default rules to the default bucket only', async () => {
    const sandbox = freshSandbox();
    lockUndeployedStorageBuckets(sandbox);
    await replaceStorageRules(sandbox, OPEN);
    expect(await uploadOutcome(appStorage(sandbox), 'a.txt')).toBe('ok');
    expect(await uploadOutcome(appStorage(sandbox, `gs://${MEDIA_BUCKET}`), 'a.txt')).toBe('storage/unauthorized');
  });

  it('keeps one shared ruleset for a sandbox opened with rules and no per-bucket deploy', async () => {
    const sandbox = initializeSandbox({});
    getStorageSandbox(sandbox, { dbName: uniqueName('shared'), rules: OPEN });
    expect(await uploadOutcome(getStorageSandbox(sandbox, { bucket: MEDIA_BUCKET }), 'a.txt')).toBe('ok');
  });

  it('a null source with a bucket removes that bucket rules, which locks it', async () => {
    const sandbox = freshSandbox();
    await deployHuntRules(sandbox);
    await replaceStorageRules(sandbox, null, { bucket: MEDIA_BUCKET });
    expect(await uploadOutcome(appStorage(sandbox, `gs://${MEDIA_BUCKET}`), 'a.txt')).toBe('storage/unauthorized');
  });

  it('locks a second app default bucket rather than share the first one objects (review of #1524)', async () => {
    const sandbox = freshSandbox();
    lockUndeployedStorageBuckets(sandbox);
    const writeOnly = OPEN.replace('allow read, write: if true;', 'allow write: if true; allow read: if false;');
    await replaceStorageRules(sandbox, writeOnly, { bucket: 'strict-bucket' });
    await replaceStorageRules(sandbox, OPEN, { bucket: 'open-bucket' });
    const strict = getStorage(createAppForSandbox(sandbox, { projectId: 'p', storageBucket: 'strict-bucket' }, uniqueName('a')));
    const open = getStorage(createAppForSandbox(sandbox, { projectId: 'p', storageBucket: 'open-bucket' }, uniqueName('b')));
    expect(await uploadOutcome(strict, 'x.txt')).toBe('ok');
    await expect(getBytes(ref(strict, 'x.txt'))).rejects.toMatchObject({ code: 'storage/unauthorized' });
    await expect(getBytes(ref(open, 'x.txt'))).rejects.toThrow('is a second default bucket in this sandbox, which already serves "strict-bucket"');
  });

  it('pins the default store to the first app opened with usable rules even when the second app runs first (#1538)', async () => {
    const sandbox = freshSandbox();
    lockUndeployedStorageBuckets(sandbox);
    await replaceStorageRules(sandbox, OPEN, { bucket: 'first-bucket' });
    await replaceStorageRules(sandbox, OPEN, { bucket: 'second-bucket' });
    const first = getStorage(createAppForSandbox(sandbox, { projectId: 'p', storageBucket: 'first-bucket' }, uniqueName('first')));
    const second = getStorage(createAppForSandbox(sandbox, { projectId: 'p', storageBucket: 'second-bucket' }, uniqueName('second')));
    await expect(uploadBytes(ref(second, 'x.txt'), BYTES)).rejects.toThrow(
      'Storage bucket "second-bucket" is a second default bucket in this sandbox, which already serves "first-bucket"',
    );
    expect(await uploadOutcome(first, 'x.txt')).toBe('ok');
  });

  it('does not let a mistyped undeployed storageBucket lock out the deployed default bucket when run first (#1538)', async () => {
    const sandbox = freshSandbox();
    lockUndeployedStorageBuckets(sandbox);
    await replaceStorageRules(sandbox, OPEN, { bucket: DEFAULT_BUCKET });
    const mistyped = getStorage(createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: 'mistyped-app.appspot.com' }, uniqueName('mistyped')));
    await expect(uploadBytes(ref(mistyped, 'x.txt'), BYTES)).rejects.toThrow(
      'Storage bucket "mistyped-app.appspot.com" has no rules deployed in firebase.json',
    );
    const correct = getStorage(createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: DEFAULT_BUCKET }, uniqueName('correct')));
    expect(await uploadOutcome(correct, 'x.txt')).toBe('ok');
  });

  it('pins [DEFAULT] app before a second sandbox app even when getStorage(secondApp) runs first (#1538)', async () => {
    const sandbox = freshSandbox();
    lockUndeployedStorageBuckets(sandbox);
    await replaceStorageRules(sandbox, OPEN, { bucket: DEFAULT_BUCKET });
    await replaceStorageRules(sandbox, OPEN, { bucket: 'named-bucket' });
    await resetAppRegistryForTests();
    try {
      bindAppRegistrySandbox(sandbox);
      const defaultApp = initializeApp({ projectId: 'demo-app', storageBucket: DEFAULT_BUCKET });
      const namedApp = createAppForSandbox(
        sandbox,
        { projectId: 'demo-app', storageBucket: 'named-bucket' },
        uniqueName('named'),
      );
      const namedStorage = getStorage(namedApp);
      await expect(uploadBytes(ref(namedStorage, 'x.txt'), BYTES)).rejects.toThrow(
        `Storage bucket "named-bucket" is a second default bucket in this sandbox, which already serves "${DEFAULT_BUCKET}"`,
      );
      expect(await uploadOutcome(getStorage(defaultApp), 'x.txt')).toBe('ok');
    } finally {
      await resetAppRegistryForTests();
    }
  });

  it('pruneStorageBucketRules clears unkept default-store pins and claimed buckets under permissive policy (#1538)', async () => {
    const sandbox = freshSandbox();
    lockUndeployedStorageBuckets(sandbox, 'allow');
    const dirtyApp = createAppForSandbox(
      sandbox,
      { projectId: 'demo-app', storageBucket: 'dirty-bucket' },
      uniqueName('dirty'),
    );
    expect(await uploadOutcome(getStorage(dirtyApp), 'x.txt')).toBe('ok');
    await replaceStorageRules(sandbox, OPEN, { bucket: DEFAULT_BUCKET });
    pruneStorageBucketRules(sandbox, new Set([DEFAULT_BUCKET]));
    const restoredApp = createAppForSandbox(
      sandbox,
      { projectId: 'demo-app', storageBucket: DEFAULT_BUCKET },
      uniqueName('restored'),
    );
    expect(await uploadOutcome(getStorage(restoredApp), 'x.txt')).toBe('ok');
  });

  describe('permissive mode (owner decision multi-resource-1)', () => {
    it('opens a bucket nothing deploys to, and the default bucket with no rules', async () => {
      const sandbox = freshSandbox();
      lockUndeployedStorageBuckets(sandbox, 'allow');
      expect(await uploadOutcome(appStorage(sandbox), 'a.txt')).toBe('ok');
      expect(await uploadOutcome(appStorage(sandbox, 'gs://other-bucket'), 'a.txt')).toBe('ok');
      expect(await uploadOutcome(getStorageSandbox(sandbox, { bucket: 'other-bucket' }), 'b.txt')).toBe('ok');
    });

    it('still enforces the rules deployed to a bucket', async () => {
      const sandbox = freshSandbox();
      lockUndeployedStorageBuckets(sandbox, 'allow');
      await replaceStorageRules(sandbox, SIGNED_IN, { bucket: MEDIA_BUCKET });
      expect(await uploadOutcome(appStorage(sandbox, `gs://${MEDIA_BUCKET}`), 'a.txt')).toBe('storage/unauthorized');
      expect(await uploadOutcome(appStorage(sandbox), 'a.txt')).toBe('ok');
    });

    it('keeps the policy when a bucket is deployed after it is set', async () => {
      const sandbox = freshSandbox();
      lockUndeployedStorageBuckets(sandbox, 'allow');
      await replaceStorageRules(sandbox, SIGNED_IN, { bucket: MEDIA_BUCKET });
      await replaceStorageRules(sandbox, null, { bucket: MEDIA_BUCKET });
      expect(await uploadOutcome(appStorage(sandbox, `gs://${MEDIA_BUCKET}`), 'a.txt')).toBe('ok');
    });

    it('reports the open bucket as permissive mode, not as an evaluated rule', async () => {
      const sandbox = freshSandbox();
      lockUndeployedStorageBuckets(sandbox, 'allow');
      const events: SandboxEvent[] = [];
      sandbox.onEvent((event) => events.push(event));
      await uploadBytes(ref(appStorage(sandbox, 'gs://other-bucket'), 'a.txt'), BYTES);
      const ops = events.filter((event): event is SandboxOperationEvent => event.kind === 'operation');
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({
        service: 'storage',
        result: 'allow',
        rulesDisposition: { kind: 'not-evaluated', reason: 'no-rules' },
        detail: { bucketName: 'other-bucket', defaultPolicy: 'allow' },
      });
      expect(ops[0]?.rules).toBeUndefined();
    });

    it('a deny policy locks an undeployed bucket, as with no policy', async () => {
      const sandbox = freshSandbox();
      lockUndeployedStorageBuckets(sandbox, 'deny');
      expect(await uploadOutcome(appStorage(sandbox, 'gs://other-bucket'), 'a.txt')).toBe('storage/unauthorized');
    });
  });
});
