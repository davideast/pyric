import { describe, expect, it } from 'bun:test';
import {
  copyStorageCustomMetadataRecord,
  isAllowedStorageDownloadUrlOrigin,
  isValidStorageBucketName,
  selectPreferredStorageBucket,
  validateObservedStorageDownloadUrl,
} from '../../../src/serve/observed-session/storage-policy.js';

describe('storage-policy', () => {
  it('copies customMetadata verbatim while stripping prototype-pollution keys safely', () => {
    const raw = JSON.parse(
      JSON.stringify({
        ownerUid: 'u-1',
        author: 'alice',
        firebaseStorageDownloadTokens: 'tok-example-1,tok-example-2',
        apiKey: 'live-api-key-value',
        webhookSecret: 'whsec_123',
        passphrase: 'correct-horse-battery-staple',
        sessionId: 'sess-123',
        note: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload123.sig456',
      }),
    ) as Record<string, string>;
    Object.defineProperty(raw, '__proto__', {
      value: 'polluted',
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(raw, 'constructor', {
      value: 'bad-ctor',
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(raw, 'prototype', {
      value: 'bad-proto',
      enumerable: true,
      configurable: true,
    });

    const copied = copyStorageCustomMetadataRecord(raw);
    expect(copied).toEqual({
      ownerUid: 'u-1',
      author: 'alice',
      firebaseStorageDownloadTokens: 'tok-example-1,tok-example-2',
      apiKey: 'live-api-key-value',
      webhookSecret: 'whsec_123',
      passphrase: 'correct-horse-battery-staple',
      sessionId: 'sess-123',
      note: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload123.sig456',
    });
    expect(Object.hasOwn(copied, '__proto__')).toBe(false);
    expect(Object.hasOwn(copied, 'constructor')).toBe(false);
    expect(Object.hasOwn(copied, 'prototype')).toBe(false);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
  });

  it('allowlists Firebase/GCS/loopback origins and preserves query parameters and fragments verbatim on downloadUrl', () => {
    expect(
      validateObservedStorageDownloadUrl(
        'https://firebasestorage.googleapis.com/v0/b/demo-items.firebasestorage.app/o/items%2Fcover.png?alt=media&token=tok-1111-2222#frag',
      ),
    ).toBe(
      'https://firebasestorage.googleapis.com/v0/b/demo-items.firebasestorage.app/o/items%2Fcover.png?alt=media&token=tok-1111-2222#frag',
    );

    const signedGcsUrl =
      'https://storage.googleapis.com/demo-items/items/cover.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc&X-Goog-Date=20261109T000000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=deadbeef&generation=1';
    expect(validateObservedStorageDownloadUrl(signedGcsUrl)).toBe(signedGcsUrl);

    // Explicit default HTTPS port (:443) normalizes cleanly; non-default ports on production hosts are rejected.
    expect(
      validateObservedStorageDownloadUrl(
        'https://storage.googleapis.com:443/demo-items/items/cover.png?alt=media&token=tok-443',
      ),
    ).toBe('https://storage.googleapis.com/demo-items/items/cover.png?alt=media&token=tok-443');
    expect(
      validateObservedStorageDownloadUrl(
        'https://firebasestorage.googleapis.com:8443/v0/b/demo-items/o/a.png?alt=media',
      ),
    ).toBeUndefined();
    expect(
      validateObservedStorageDownloadUrl('https://storage.googleapis.com:8080/demo-items/a.png'),
    ).toBeUndefined();
    expect(
      validateObservedStorageDownloadUrl('https://demo-items.firebasestorage.app:9443/a.png'),
    ).toBeUndefined();

    expect(
      validateObservedStorageDownloadUrl(
        'https://demo-items.firebasestorage.app/items/cover.png?token=abc',
      ),
    ).toBe('https://demo-items.firebasestorage.app/items/cover.png?token=abc');

    expect(
      validateObservedStorageDownloadUrl(
        'http://127.0.0.1:9199/v0/b/demo-items.appspot.com/o/a.png?alt=media&token=emu-tok',
      ),
    ).toBe('http://127.0.0.1:9199/v0/b/demo-items.appspot.com/o/a.png?alt=media&token=emu-tok');

    // Untrusted hosts, non-HTTPS cloud origins, oversized URLs, and embedded userinfo are rejected:
    expect(validateObservedStorageDownloadUrl('https://attacker.example/phish')).toBeUndefined();
    expect(validateObservedStorageDownloadUrl('https://evilfirebasestorage.app/a.png')).toBeUndefined();
    expect(
      validateObservedStorageDownloadUrl('http://firebasestorage.googleapis.com/v0/b/demo/o/a.png'),
    ).toBeUndefined();
    expect(
      validateObservedStorageDownloadUrl('https://user:pass@storage.googleapis.com/demo/a.png'),
    ).toBeUndefined();
    expect(
      validateObservedStorageDownloadUrl(
        `https://storage.googleapis.com/demo/${'a'.repeat(2100)}.png`,
      ),
    ).toBeUndefined();
    expect(isAllowedStorageDownloadUrlOrigin(new URL('https://attacker.example/phish'))).toBe(false);
  });

  it('validates canonical lowercase Storage bucket names and selects preferred project buckets consistently', () => {
    expect(isValidStorageBucketName('demo-items.firebasestorage.app')).toBe(true);
    expect(isValidStorageBucketName('demo_items-01.appspot.com')).toBe(true);
    expect(isValidStorageBucketName('Demo-Items.firebasestorage.app')).toBe(false);
    expect(isValidStorageBucketName('gs://demo-items')).toBe(false);
    expect(isValidStorageBucketName('ab')).toBe(false);
    expect(isValidStorageBucketName('-demo-items')).toBe(false);
    expect(isValidStorageBucketName('__proto__')).toBe(false);

    expect(selectPreferredStorageBucket([], 'demo-proj')).toBeNull();
    expect(
      selectPreferredStorageBucket(
        ['secondary-bucket', 'demo-proj.appspot.com', 'demo-proj.firebasestorage.app'],
        'demo-proj',
      ),
    ).toBe('demo-proj.firebasestorage.app');
    expect(
      selectPreferredStorageBucket(['secondary-bucket', 'demo-proj.appspot.com'], 'demo-proj'),
    ).toBe('demo-proj.appspot.com');
    expect(selectPreferredStorageBucket(['secondary-bucket', 'tertiary-bucket'], 'demo-proj')).toBe(
      'secondary-bucket',
    );
  });
});
