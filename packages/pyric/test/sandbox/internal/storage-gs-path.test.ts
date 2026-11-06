import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from '../../../src/sandbox/index.js';
import { storageGsPath } from '../../../src/sandbox/internal/storage-gs-path.js';

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
