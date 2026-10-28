/**
 * `storageRulesConfig` resolves the `storage` block of a `firebase.json` the
 * way firebase-tools 15.24.0 deploys it (`lib/deploy/storage/prepare.js` and
 * `release.js`). Each test name cites the behavior it ports.
 */
import { describe, expect, it } from 'bun:test';
import { storageRulesConfig } from '../../../src/sandbox/internal/storage-rules-config.js';

describe('storageRulesConfig', () => {
  it('prepare.js: a single storage object deploys its rules to the default bucket', () => {
    expect(storageRulesConfig({ rules: 'storage.rules' })).toEqual({
      defaultRules: { file: 'storage.rules', label: 'firebase.json storage.rules', configured: true },
      buckets: [],
      unresolved: [],
    });
  });

  it('prepare.js: a single storage object without rules deploys nothing', () => {
    expect(storageRulesConfig({})).toEqual({ defaultRules: null, buckets: [], unresolved: [] });
  });

  it('release.js: an array entry without target deploys to its bucket', () => {
    const config = storageRulesConfig([
      { bucket: 'media-bucket', rules: 'media.rules' },
      { bucket: 'demo-app.appspot.com', rules: 'storage.rules' },
    ]);
    expect(config.defaultRules).toBeNull();
    expect(config.buckets).toEqual([
      { bucket: 'media-bucket', file: 'media.rules', label: 'firebase.json storage[0]', configured: true },
      { bucket: 'demo-app.appspot.com', file: 'storage.rules', label: 'firebase.json storage[1]', configured: true },
    ]);
  });

  it('release.js: an array entry with target deploys to every bucket .firebaserc maps it to', () => {
    const config = storageRulesConfig([{ target: 'uploads', rules: 'uploads.rules' }], {
      targetBuckets: (target) => (target === 'uploads' ? ['bucket-a', 'bucket-b'] : undefined),
    });
    expect(config.buckets.map((target) => target.bucket)).toEqual(['bucket-a', 'bucket-b']);
    expect(config.unresolved).toEqual([]);
  });

  it('prepare.js requireTarget: an unmapped target is returned unresolved', () => {
    const config = storageRulesConfig([{ target: 'uploads', rules: 'uploads.rules' }]);
    expect(config.buckets).toEqual([]);
    expect(config.unresolved).toEqual([{ target: 'uploads', label: 'firebase.json storage[0]', file: 'uploads.rules' }]);
  });

  it('release.js: an entry with neither target nor bucket has no bucket to release to, and is refused', () => {
    expect(() => storageRulesConfig([{ rules: 'storage.rules' }])).toThrow(
      'firebase.json storage[0] names neither "bucket" nor "target"',
    );
  });

  it('release.js Promise.all: two different files for one bucket are refused', () => {
    expect(() =>
      storageRulesConfig([
        { bucket: 'media-bucket', rules: 'a.rules' },
        { bucket: 'media-bucket', rules: 'b.rules' },
      ]),
    ).toThrow('firebase.json deploys two rules files to Storage bucket "media-bucket": a.rules from firebase.json storage[0] and b.rules from firebase.json storage[1].');
  });

  it('accepts the same file deployed to one bucket twice', () => {
    const config = storageRulesConfig([
      { bucket: 'media-bucket', rules: 'a.rules' },
      { bucket: 'media-bucket', rules: 'a.rules' },
    ]);
    expect(config.buckets).toHaveLength(1);
  });

  it('reads storage.rules for the default bucket when firebase.json has no storage key', () => {
    expect(storageRulesConfig(undefined, { resolveFile: (file) => `/project/${file}` })).toEqual({
      defaultRules: { file: '/project/storage.rules', label: 'firebase.json', configured: false },
      buckets: [],
      unresolved: [],
    });
  });

  it('resolves each file through resolveFile', () => {
    const config = storageRulesConfig([{ bucket: 'b', rules: 'rules/b.rules' }], { resolveFile: (file) => `/p/${file}` });
    expect(config.buckets[0]?.file).toBe('/p/rules/b.rules');
  });
});
