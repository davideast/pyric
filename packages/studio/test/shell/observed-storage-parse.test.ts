import { describe, expect, it } from 'bun:test';
import {
  EMPTY_OBSERVED_SNAPSHOT,
} from '../../src/shell/observed-session-parse.js';
import {
  parseObservedStorageSection,
  withObservedStorageSection,
} from '../../src/shell/observed-storage-parse.js';

describe('parseObservedStorageSection', () => {
  it('returns undefined when no valid storage buckets are present', () => {
    expect(parseObservedStorageSection({})).toBeUndefined();
    expect(parseObservedStorageSection({ storage: null })).toBeUndefined();
    expect(parseObservedStorageSection({ storage: {} })).toBeUndefined();
  });

  it('preserves empty-listed buckets, parses deleted tombstones, preserves customMetadata and downloadUrl tokens verbatim, and rejects phishing URLs', () => {
    const raw = JSON.parse(
      JSON.stringify({
        defaultStorageBucket: 'demo-project.appspot.com',
        storage: {
          'demo-project.appspot.com': {
            prefixes: ['/workspaces/ws-1/', 'workspaces/ws-1'],
            deleted: ['/workspaces/ws-1/items/removed.png/'],
            objects: {
              'workspaces/ws-1/items/a.png': {
                bucket: 'demo-project.appspot.com',
                fullPath: 'workspaces/ws-1/items/a.png',
                name: 'a.png',
                size: 512,
                contentType: 'image/png',
                customMetadata: {
                  role: 'cover',
                  apiKey: 'raw-key',
                  firebaseStorageDownloadTokens: 'tok-live-1',
                },
                downloadUrl:
                  'https://firebasestorage.googleapis.com/v0/b/demo-project.appspot.com/o/a.png?alt=media&token=abc',
              },
              'workspaces/ws-1/items/phish.pdf': {
                bucket: 'demo-project.appspot.com',
                fullPath: 'workspaces/ws-1/items/phish.pdf',
                name: 'phish.pdf',
                downloadUrl: 'https://attacker.example/phish?alt=media',
              },
            },
          },
          'empty-listed-bucket': {
            prefixes: [],
            objects: {},
          },
        },
      }),
    ) as Record<string, unknown>;
    (raw.storage as Record<string, unknown>)['constructor'] = {
      prefixes: ['ignored'],
      objects: {},
    };

    const parsed = parseObservedStorageSection(raw);
    expect(parsed).toBeDefined();
    expect(parsed?.storageBuckets).toBe(2);
    expect(parsed?.storageObjects).toBe(2);
    expect(parsed?.defaultStorageBucket).toBe('demo-project.appspot.com');

    const bucket = parsed!.storage['demo-project.appspot.com']!;
    expect(bucket.prefixes).toEqual(['workspaces/ws-1']);
    expect(bucket.deleted).toEqual(['workspaces/ws-1/items/removed.png']);
    expect(bucket.objects['workspaces/ws-1/items/a.png']?.customMetadata).toEqual({
      role: 'cover',
      apiKey: 'raw-key',
      firebaseStorageDownloadTokens: 'tok-live-1',
    });
    expect(bucket.objects['workspaces/ws-1/items/a.png']?.downloadUrl).toBe(
      'https://firebasestorage.googleapis.com/v0/b/demo-project.appspot.com/o/a.png?alt=media&token=abc',
    );
    expect(bucket.objects['workspaces/ws-1/items/phish.pdf']?.downloadUrl).toBeUndefined();
    expect(parsed?.storage['empty-listed-bucket']).toEqual({ prefixes: [], objects: {} });

    const attached = withObservedStorageSection(EMPTY_OBSERVED_SNAPSHOT, raw);
    expect(attached.stats.storageBuckets).toBe(2);
    expect(attached.stats.storageObjects).toBe(2);
  });
});
