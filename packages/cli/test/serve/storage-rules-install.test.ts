/**
 * Every served plane installs the project's Storage rules per bucket (#1313):
 * the default bucket and each bucket `firebase.json` names enforce their own
 * file, a bucket nothing deploys to is locked, one bucket's reload leaves the
 * others alone, and a deploy target no project resolved at startup deploys
 * to its buckets once the app config names the project.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from 'pyric/app/internal';
import { getStorage, ref, uploadBytes } from 'pyric/storage';
import {
  applyStorageRulesUpdate,
  installServedStorageRules,
  resolvePendingStorageTargets,
  storageRulesUpdateFor,
} from '../../src/serve/storage-rules-install.js';
import type { InitPayload } from '../../src/serve/init-payload.js';

const DEFAULT_BUCKET = 'demo-app.appspot.com';

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

type StoragePayload = Pick<InitPayload, 'storageRules' | 'storageBucketRules' | 'storagePendingTargets' | 'projectKey'>;

function uniqueName(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function served(payload: Partial<StoragePayload>): { sandbox: LocalSandbox; notices: string[] } {
  const sandbox = initializeSandbox({});
  const notices = installServedStorageRules(sandbox, {
    storageRules: null,
    projectKey: uniqueName('/project'),
    ...payload,
  });
  return { sandbox, notices };
}

async function uploadOutcome(sandbox: LocalSandbox, bucketUrl?: string): Promise<string> {
  const app = createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: DEFAULT_BUCKET }, uniqueName('app'));
  try {
    await uploadBytes(ref(getStorage(app, bucketUrl), 'uploads/a.txt'), new Uint8Array([1]));
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

async function outcomes(sandbox: LocalSandbox): Promise<Record<string, string>> {
  return {
    default: await uploadOutcome(sandbox),
    media: await uploadOutcome(sandbox, 'gs://media-bucket'),
    other: await uploadOutcome(sandbox, 'gs://other-bucket'),
  };
}

const HUNT_BUCKETS = {
  'media-bucket': { rules: OPEN, rulesHash: 'm' },
  [DEFAULT_BUCKET]: { rules: SIGNED_IN, rulesHash: 's' },
};

describe('installServedStorageRules', () => {
  it('gives each bucket firebase.json names its own rules and locks the rest (the hunt repro)', async () => {
    const { sandbox } = served({ storageBucketRules: HUNT_BUCKETS });
    expect(await outcomes(sandbox)).toEqual({
      default: 'storage/unauthorized',
      media: 'ok',
      other: 'storage/unauthorized',
    });
  });

  it('enforces a single storage object on the default bucket and locks every named bucket', async () => {
    const { sandbox } = served({ storageRules: OPEN });
    expect(await outcomes(sandbox)).toEqual({ default: 'ok', media: 'storage/unauthorized', other: 'storage/unauthorized' });
  });

  it("replaces one bucket's rules and leaves the other buckets alone", async () => {
    const { sandbox } = served({ storageBucketRules: HUNT_BUCKETS });
    await applyStorageRulesUpdate(sandbox, { rules: SIGNED_IN, bucket: 'media-bucket' });
    await applyStorageRulesUpdate(sandbox, { rules: OPEN, bucket: DEFAULT_BUCKET });
    expect(await outcomes(sandbox)).toEqual({ default: 'ok', media: 'storage/unauthorized', other: 'storage/unauthorized' });
  });

  it('locks a bucket whose rules file was deleted', async () => {
    const { sandbox } = served({ storageBucketRules: HUNT_BUCKETS });
    await applyStorageRulesUpdate(sandbox, { rules: null, bucket: 'media-bucket' });
    expect((await outcomes(sandbox)).media).toBe('storage/unauthorized');
  });
});

describe('pending Storage deploy targets', () => {
  const pending = [{ target: 'media', rules: OPEN, bucketsByProject: { 'demo-app': ['media-bucket'] } }];

  it("stay locked until the app config names a project, then deploy to the buckets .firebaserc maps for it", async () => {
    const { sandbox, notices } = served({ storagePendingTargets: pending });
    expect(notices).toEqual([]);
    expect((await outcomes(sandbox)).media).toBe('storage/unauthorized');
    expect(resolvePendingStorageTargets(sandbox, 'demo-app')).toEqual([
      'Storage deploy target "media" resolved with the app config project "demo-app": its rules now apply to media-bucket.',
    ]);
    expect(await outcomes(sandbox)).toEqual({ default: 'storage/unauthorized', media: 'ok', other: 'storage/unauthorized' });
    expect(resolvePendingStorageTargets(sandbox, 'other-project')).toEqual([]);
  });

  it('resolve at install with the project an app config named first', async () => {
    const sandbox = initializeSandbox({});
    expect(resolvePendingStorageTargets(sandbox, 'demo-app')).toEqual([]);
    const notices = installServedStorageRules(sandbox, { storageRules: null, projectKey: uniqueName('/project'), storagePendingTargets: pending });
    expect(notices).toHaveLength(1);
    expect((await outcomes(sandbox)).media).toBe('ok');
  });

  it('stay locked for a project .firebaserc does not map them for', async () => {
    const { sandbox } = served({ storagePendingTargets: pending });
    expect(resolvePendingStorageTargets(sandbox, 'other-project')[0]).toContain('has no .firebaserc mapping');
    expect((await outcomes(sandbox)).media).toBe('storage/unauthorized');
  });

  it("take a reloaded rules file on the buckets they resolved to", async () => {
    const { sandbox } = served({ storagePendingTargets: pending });
    resolvePendingStorageTargets(sandbox, 'demo-app');
    await applyStorageRulesUpdate(sandbox, { rules: SIGNED_IN, target: 'media' });
    expect((await outcomes(sandbox)).media).toBe('storage/unauthorized');
  });
});

describe('storageRulesUpdateFor', () => {
  it('reads a Node host deploy destination as a bucket, a pending target, or the default bucket', () => {
    expect(storageRulesUpdateFor(OPEN, undefined)).toEqual({ rules: OPEN });
    expect(storageRulesUpdateFor(OPEN, { bucket: 'media-bucket' })).toEqual({ rules: OPEN, bucket: 'media-bucket' });
    expect(storageRulesUpdateFor(null, { target: 'media' })).toEqual({ rules: null, target: 'media' });
    expect(() => storageRulesUpdateFor(OPEN, 'demo-app-default-rtdb')).toThrow();
  });
});
