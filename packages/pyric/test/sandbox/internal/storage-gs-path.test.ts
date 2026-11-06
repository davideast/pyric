import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from '../../../src/sandbox/index.js';
import { storageGsPath, storageObjectGsPath } from '../../../src/sandbox/internal/storage-gs-path.js';
import { observeStorageOperation } from '../../../src/sandbox/internal/storage-activity.js';
import { sdkActivity } from '../../../src/sandbox/internal/sdk-activity.js';

function storageOperation(detail: Record<string, unknown> | undefined): SandboxEvent {
  return {
    kind: 'operation', service: 'storage', method: 'getBytes', id: 'e1', at: 0,
    auth: null, result: 'allow', ...(detail === undefined ? {} : { detail }),
  } as unknown as SandboxEvent;
}

describe('storageGsPath', () => {
  it('names the app bucket from bucketName before the store key in bucket', () => {
    const event = storageOperation({ bucket: 'pyric-default', bucketName: 'demo.appspot.com' });
    expect(storageGsPath(event, 'avatars/a.png')).toBe('gs://demo.appspot.com/avatars/a.png');
  });

  it('reads bucket when bucketName is absent, as production sends it', () => {
    const event = storageOperation({ bucket: 'demo.appspot.com' });
    expect(storageGsPath(event, 'avatars/a.png')).toBe('gs://demo.appspot.com/avatars/a.png');
  });

  it('counts an empty bucketName as none', () => {
    const event = storageOperation({ bucket: 'demo.appspot.com', bucketName: '' });
    expect(storageGsPath(event, 'a.png')).toBe('gs://demo.appspot.com/a.png');
  });

  it('gives the bucket root for a root ref or a missing path', () => {
    const event = storageOperation({ bucket: 'demo.appspot.com' });
    expect(storageGsPath(event, '')).toBe('gs://demo.appspot.com/');
    expect(storageGsPath(event, undefined)).toBe('gs://demo.appspot.com/');
  });

  it('drops leading slashes from the object path', () => {
    const event = storageOperation({ bucket: 'demo.appspot.com' });
    expect(storageGsPath(event, '//avatars/a.png')).toBe('gs://demo.appspot.com/avatars/a.png');
  });

  it('is undefined when the operation names no bucket', () => {
    expect(storageGsPath(storageOperation(undefined), 'a.png')).toBeUndefined();
    expect(storageGsPath(storageOperation({ bucket: '', bucketName: '' }), 'a.png')).toBeUndefined();
    expect(storageGsPath(storageOperation({ bucket: 42 }), 'a.png')).toBeUndefined();
  });

  it('is undefined for an event outside Storage', () => {
    const event = { ...storageOperation({ bucket: 'b' }), service: 'firestore' } as unknown as SandboxEvent;
    expect(storageGsPath(event, 'users/a')).toBeUndefined();
  });
});

describe('the activity source a Storage call records', () => {
  /** The source target one call records, for a reference and its bucket's name. */
  function recordedTarget(ref: { bucket: string; fullPath: string }, bucketNameOf?: (ref: { bucket: string }) => string): string | undefined {
    const call = observeStorageOperation('getMetadata', async () => ({}), bucketNameOf);
    void call(ref);
    return sdkActivity.records().at(-1)?.target;
  }

  it('reads as the Traffic row for the same object', () => {
    const event = storageOperation({ bucket: 'pyric-default', bucketName: 'demo.appspot.com' });
    const target = recordedTarget({ bucket: 'pyric-default', fullPath: 'avatars/a.png' }, () => 'demo.appspot.com');
    expect(target).toBe(storageGsPath(event, 'avatars/a.png'));
    expect(target).toBe('gs://demo.appspot.com/avatars/a.png');
  });

  it("names a worker reference's bucket from the reference", () => {
    expect(recordedTarget({ bucket: 'demo.appspot.com', fullPath: 'avatars/a.png' })).toBe('gs://demo.appspot.com/avatars/a.png');
  });

  it('keeps a bucketless reference out of every bucket', () => {
    const target = recordedTarget({ bucket: '', fullPath: 'avatars/a.png' });
    expect(target).toBe('avatars/a.png');
    expect(storageObjectGsPath('', 'avatars/a.png')).toBeUndefined();
    expect(storageObjectGsPath(undefined, 'avatars/a.png')).toBeUndefined();
  });
});
