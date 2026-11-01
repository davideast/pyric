/**
 * Storage rules see the bucket under the name the caller knows it by, not the
 * store's internal key `pyric-default` (ST-H2-4). Production binds the real
 * bucket name in the match path, `request.resource.bucket` and
 * `resource.bucket` (`oracle:rules-storage-storage-named-bucket-binding`).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from '../../../src/app/internal.js';
import { getMetadata, getStorage, ref, uploadBytes } from '../../../src/storage/index.js';
import { getStorageSandbox } from '../../../src/storage/service.js';
import { rulesBucketName } from '../../../src/storage/sandbox/rules-bucket-name.js';

const BUCKET = 'demo-app.appspot.com';

/** Allows only objects in the bucket the match path names. */
const LITERAL_BUCKET_RULES = `rules_version = '2';
service firebase.storage {
  match /b/${BUCKET}/o {
    match /literal/{file} {
      allow read, write: if true;
    }
  }
}`;

/** Each rule allows only when the rules see the app's bucket name. */
const BOUND_BUCKET_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /wildcard/{file} {
      allow read, write: if bucket == '${BUCKET}';
    }
    match /request/{file} {
      allow write: if request.resource.bucket == '${BUCKET}';
    }
    match /resource/{file} {
      allow write: if true;
      allow read: if resource.bucket == '${BUCKET}';
    }
  }
}`;

function uniqueName(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

/** An in-page app whose `storageBucket` names the bucket, with the rules above in force. */
function appStorage(bucketUrl?: string, rules: string = BOUND_BUCKET_RULES) {
  const sandbox = initializeSandbox({});
  getStorageSandbox(sandbox, { dbName: uniqueName('bucket-name'), rules });
  const app = createAppForSandbox(sandbox, { projectId: 'demo-app', storageBucket: BUCKET }, uniqueName('app'));
  return getStorage(app, bucketUrl);
}

const BYTES = new TextEncoder().encode('hello');

describe('rulesBucketName', () => {
  it('is the name the caller knows the bucket by', () => {
    expect(rulesBucketName('pyric-default', BUCKET)).toBe(BUCKET);
  });

  it('reads a gs:// bucket URL as its bucket name', () => {
    expect(rulesBucketName('pyric-default', `gs://${BUCKET}`)).toBe(BUCKET);
    expect(rulesBucketName('pyric-default', `gs://${BUCKET}/`)).toBe(BUCKET);
  });

  it('is the stored key when the caller names none', () => {
    expect(rulesBucketName('pyric-default', undefined)).toBe('pyric-default');
    expect(rulesBucketName('media', '')).toBe('media');
  });
});

describe('the in-page plane', () => {
  it('matches a literal match /b/<storageBucket>/o', async () => {
    await uploadBytes(ref(appStorage(undefined, LITERAL_BUCKET_RULES), 'literal/a.txt'), BYTES);
  });

  it('binds {bucket} to the app storageBucket', async () => {
    await uploadBytes(ref(appStorage(), 'wildcard/a.txt'), BYTES);
  });

  it('binds request.resource.bucket to the app storageBucket', async () => {
    await uploadBytes(ref(appStorage(), 'request/a.txt'), BYTES);
  });

  it('binds resource.bucket to the app storageBucket', async () => {
    const storage = appStorage();
    await uploadBytes(ref(storage, 'resource/a.txt'), BYTES);
    await getMetadata(ref(storage, 'resource/a.txt'));
  });

  it('uses the bucket URL getStorage was given', async () => {
    await uploadBytes(ref(appStorage(`gs://${BUCKET}`), 'wildcard/b.txt'), BYTES);
  });

  it('leaves the metadata bucket as it was', async () => {
    const result = await uploadBytes(ref(appStorage(), 'wildcard/c.txt'), BYTES);
    expect(result.metadata.bucket).toBe('pyric-default');
  });
});
