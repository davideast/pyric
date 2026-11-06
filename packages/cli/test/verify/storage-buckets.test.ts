/**
 * `pyric verify` replays each Storage bucket under its own candidate rules
 * (#1313). Production keeps one release per bucket, so a bucket enforces only
 * its own file, and a bucket nothing deploys to replays as locked (owner
 * decision multi-resource-1).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from 'pyric/app/internal';
import { getStorage, getStorageSandbox, ref, uploadBytes } from 'pyric/storage';
import { lockUndeployedStorageBuckets, nameStorageBucket, replaceStorageRules } from 'pyric/storage/internal';

import { buildVerifyFixture, verifyFixture, type PyricVerifyFixture } from '../../src/verify/index.js';

const DEFAULT_BUCKET = 'demo-app.appspot.com';
const MEDIA_BUCKET = 'media-bucket';

const OPEN = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;

const SIGNED_IN = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if request.auth != null; }
  }
}`;

const BYTES = new Uint8Array([1]);

function uniqueName(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A session with sign-in rules on the default bucket and open rules on
 * media-bucket: alice uploads to each, and a signed-out visitor uploads to
 * media-bucket.
 */
async function captureTwoBuckets(): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: uniqueName('verify-buckets') });
  lockUndeployedStorageBuckets(sandbox);
  await replaceStorageRules(sandbox, SIGNED_IN, { bucket: DEFAULT_BUCKET });
  await replaceStorageRules(sandbox, OPEN, { bucket: MEDIA_BUCKET });
  const alice = sandbox.withAuth({ uid: 'alice' });
  const visitor = createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: DEFAULT_BUCKET }, uniqueName('app'));
  await uploadBytes(ref(nameStorageBucket(getStorageSandbox(alice), DEFAULT_BUCKET), 'a.txt'), BYTES);
  await uploadBytes(ref(getStorageSandbox(alice, { bucket: MEDIA_BUCKET }), 'b.txt'), BYTES);
  await uploadBytes(ref(getStorage(visitor, `gs://${MEDIA_BUCKET}`), 'c.txt'), BYTES);
  return buildVerifyFixture({ sandbox, storageRules: SIGNED_IN });
}

function summary(fixtureResult: Awaited<ReturnType<typeof verifyFixture>>) {
  return (fixtureResult.services.storage?.divergences ?? []).map((divergence) => ({
    kind: divergence.kind,
    bucket: divergence.bucket,
    path: divergence.path,
  }));
}

describe('verifyFixture checks each Storage bucket against its own rules', () => {
  it('replays the session under the rules each bucket had with no divergence', async () => {
    const result = await verifyFixture(await captureTwoBuckets(), {
      rules: { storage: SIGNED_IN, storageBuckets: { [MEDIA_BUCKET]: OPEN } },
    });
    expect(result.services.storage?.checkedEvents).toBe(3);
    expect(summary(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('reports now-denied on the bucket whose candidate rules tightened, tagged with it', async () => {
    const result = await verifyFixture(await captureTwoBuckets(), {
      rules: { storage: SIGNED_IN, storageBuckets: { [MEDIA_BUCKET]: SIGNED_IN } },
    });
    expect(result.ok).toBe(false);
    expect(summary(result)).toEqual([{ kind: 'now-denied', bucket: MEDIA_BUCKET, path: 'c.txt' }]);
  });

  it('replays a bucket with no candidate rules as locked', async () => {
    const result = await verifyFixture(await captureTwoBuckets(), {
      rules: { storage: SIGNED_IN, storageBuckets: {} },
    });
    expect(summary(result)).toEqual([
      { kind: 'now-denied', bucket: MEDIA_BUCKET, path: 'b.txt' },
      { kind: 'now-denied', bucket: MEDIA_BUCKET, path: 'c.txt' },
    ]);
  });

  it('takes the default bucket rules by its name', async () => {
    const result = await verifyFixture(await captureTwoBuckets(), {
      rules: { storageBuckets: { [DEFAULT_BUCKET]: OPEN, [MEDIA_BUCKET]: OPEN } },
    });
    expect(summary(result)).toEqual([]);
  });

  it('keeps one ruleset for every bucket when no bucket rules are passed', async () => {
    const result = await verifyFixture(await captureTwoBuckets(), { rules: { storage: SIGNED_IN } });
    expect(summary(result)).toEqual([{ kind: 'now-denied', bucket: MEDIA_BUCKET, path: 'c.txt' }]);
  });
});
