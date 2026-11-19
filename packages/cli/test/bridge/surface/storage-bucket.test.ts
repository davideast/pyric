/**
 * How a `storage` call's `bucket` argument becomes a bucket selector and a
 * Cloud Storage handle under the surface's held identity.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { DEFAULT_BUCKET, targetOf } from 'pyric/storage/internal';

import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import {
  onBucket,
  parseStorageBucket,
  selectedStorageBucket,
  storageAtBucket,
} from '../../../src/bridge/surface/storage-bucket.js';
import type { SurfaceContext } from '../../../src/bridge/surface/types.js';

function contextWithDefault(defaultBucket?: string): SurfaceContext {
  const ctx = createSurfaceContext(initializeSandbox());
  if (defaultBucket !== undefined) {
    ctx.storageBucketName = () => defaultBucket;
  }
  return ctx;
}

describe('parseStorageBucket', () => {
  it.each(['default', 'DEFAULT'])('treats %p as the default bucket keyword', (raw) => {
    expect(parseStorageBucket(raw)).toBeUndefined();
  });

  it.each([
    ['media-bucket', 'media-bucket'],
    ['gs://media-bucket', 'media-bucket'],
    ['gs://media-bucket/', 'media-bucket'],
    ['https://firebasestorage.googleapis.com/v0/b/media-bucket/o', 'media-bucket'],
    ['https://firebasestorage.googleapis.com/v0/b/media-bucket/o/', 'media-bucket'],
  ])('parses %p to %p', (raw, expected) => {
    expect(parseStorageBucket(raw)).toBe(expected);
  });

  it.each([
    ['gs://media-bucket/uploads/a.txt', 'Invalid default bucket'],
    ['https://firebasestorage.googleapis.com/v0/b/media-bucket/o/uploads%2Fa.txt', 'Invalid default bucket'],
    ['https://storage.googleapis.com/media-bucket/uploads/a.txt', 'Invalid default bucket'],
    ['', 'Invalid bucket'],
    ['gs://', 'Invalid bucket'],
    ['media-bucket/nested', 'Invalid bucket'],
    ['https://storage.googleapis.com/media-bucket', 'Invalid bucket'],
  ])('rejects malformed bucket %p', (raw, expectedMessage) => {
    expect(() => parseStorageBucket(raw)).toThrow(expectedMessage);
  });
});

describe('selectedStorageBucket', () => {
  it('selects the default bucket when bucket is omitted', () => {
    expect(selectedStorageBucket(contextWithDefault('demo-app.appspot.com'), undefined)).toBeUndefined();
  });

  it.each([
    'default',
    'DEFAULT',
    'demo-app.appspot.com',
    'gs://demo-app.appspot.com',
    'gs://demo-app.appspot.com/',
  ])('selects the default bucket when %p names the configured default bucket', (raw) => {
    expect(selectedStorageBucket(contextWithDefault('demo-app.appspot.com'), raw)).toBeUndefined();
  });

  it('selects a non-default bucket by bare name or gs:// URL', () => {
    const ctx = contextWithDefault('demo-app.appspot.com');
    expect(selectedStorageBucket(ctx, 'media-bucket')).toBe('media-bucket');
    expect(selectedStorageBucket(ctx, 'gs://media-bucket/')).toBe('media-bucket');
  });
});

describe('storageAtBucket', () => {
  it('opens the default bucket store for undefined and scopes named buckets separately', () => {
    const ctx = contextWithDefault('demo-app.appspot.com');
    const defaultHandle = storageAtBucket(ctx, undefined);
    const mediaHandle = storageAtBucket(ctx, 'media-bucket');
    expect(targetOf(defaultHandle).bucket).toBe(DEFAULT_BUCKET);
    expect(targetOf(defaultHandle).bucketName).toBe('demo-app.appspot.com');
    expect(targetOf(mediaHandle).bucket).toBe('media-bucket');
    expect(targetOf(mediaHandle).bucketName).toBe('media-bucket');
  });
});

describe('onBucket', () => {
  it('names a non-default bucket and leaves the default bucket unnamed', () => {
    expect(onBucket('Uploaded a.txt (2 bytes)', 'media-bucket')).toBe(
      'Uploaded a.txt (2 bytes) on media-bucket',
    );
    expect(onBucket('Uploaded a.txt (2 bytes)', undefined)).toBe('Uploaded a.txt (2 bytes)');
  });
});
