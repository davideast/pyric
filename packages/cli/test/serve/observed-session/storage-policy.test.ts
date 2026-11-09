import { describe, expect, it } from 'bun:test';
import {
  REDACTED_STORAGE_METADATA_VALUE,
  isAllowedStorageDownloadUrlOrigin,
  isSecretStorageMetadataKey,
  isSecretStorageMetadataValue,
  isValidStorageBucketName,
  sanitizeObservedStorageDownloadUrl,
  sanitizeStorageMetadataEntry,
  scrubStorageCustomMetadataRecord,
  selectPreferredStorageBucket,
} from '../../../src/serve/observed-session/storage-policy.js';

describe('storage-policy', () => {
  it('redacts secret-named customMetadata keys and bearer/JWT values while preserving safe fields', () => {
    expect(isSecretStorageMetadataKey('firebaseStorageDownloadTokens')).toBe(true);
    expect(isSecretStorageMetadataKey('Firebase_Storage_Download_Tokens')).toBe(true);
    expect(isSecretStorageMetadataKey('apiKey')).toBe(true);
    expect(isSecretStorageMetadataKey('x-api-key')).toBe(true);
    expect(isSecretStorageMetadataKey('webhookSecret')).toBe(true);
    expect(isSecretStorageMetadataKey('passphrase')).toBe(true);
    expect(isSecretStorageMetadataKey('db_pass')).toBe(true);
    expect(isSecretStorageMetadataKey('userPass')).toBe(true);
    expect(isSecretStorageMetadataKey('sessionId')).toBe(true);
    expect(isSecretStorageMetadataKey('cookie')).toBe(true);
    expect(isSecretStorageMetadataKey('id_jwt')).toBe(true);
    expect(isSecretStorageMetadataKey('x-auth')).toBe(true);
    expect(isSecretStorageMetadataKey('authHeader')).toBe(true);
    expect(isSecretStorageMetadataKey('sig')).toBe(true);
    expect(isSecretStorageMetadataKey('urlSig')).toBe(true);

    // Safe domain nouns with overlapping substrings are preserved:
    expect(isSecretStorageMetadataKey('ownerUid')).toBe(false);
    expect(isSecretStorageMetadataKey('author')).toBe(false);
    expect(isSecretStorageMetadataKey('design')).toBe(false);
    expect(isSecretStorageMetadataKey('compass')).toBe(false);

    // Secret-shaped values under innocent keys are also scrubbed:
    expect(isSecretStorageMetadataValue('Bearer eyJhbGciOiJIUzI1NiJ9.payload123.sig456')).toBe(true);
    expect(isSecretStorageMetadataValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJl')).toBe(true);
    expect(isSecretStorageMetadataValue('plain-note')).toBe(false);

    expect(
      scrubStorageCustomMetadataRecord({
        ownerUid: 'u-1',
        author: 'alice',
        apiKey: 'must-be-redacted',
        passphrase: 'correct-horse-battery-staple',
        session: 'sess-123',
        note: 'Bearer live-token-xyz',
      }),
    ).toEqual({
      ownerUid: 'u-1',
      author: 'alice',
      apiKey: REDACTED_STORAGE_METADATA_VALUE,
      passphrase: REDACTED_STORAGE_METADATA_VALUE,
      session: REDACTED_STORAGE_METADATA_VALUE,
      note: REDACTED_STORAGE_METADATA_VALUE,
    });
    expect(sanitizeStorageMetadataEntry('sig', 'abc')).toBe(REDACTED_STORAGE_METADATA_VALUE);
  });

  it('allowlists Firebase/GCS/loopback origins and strips query credentials and fragments from downloadUrl', () => {
    expect(
      sanitizeObservedStorageDownloadUrl(
        'https://firebasestorage.googleapis.com/v0/b/demo-items.firebasestorage.app/o/items%2Fcover.png?alt=media&token=1111-2222-bearer#frag',
      ),
    ).toBe(
      'https://firebasestorage.googleapis.com/v0/b/demo-items.firebasestorage.app/o/items%2Fcover.png?alt=media',
    );

    expect(
      sanitizeObservedStorageDownloadUrl(
        'https://storage.googleapis.com/demo-items/items/cover.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc&X-Goog-Date=20261109T000000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=deadbeef&access_token=oauth-demo-token&upload_id=resumable-session-secret&sig=sas123&se=2026-11-10&sp=r&generation=1',
      ),
    ).toBe('https://storage.googleapis.com/demo-items/items/cover.png?generation=1');

    // Explicit default HTTPS port (:443) normalizes cleanly; non-default ports on production hosts are rejected.
    expect(
      sanitizeObservedStorageDownloadUrl(
        'https://storage.googleapis.com:443/demo-items/items/cover.png?alt=media',
      ),
    ).toBe('https://storage.googleapis.com/demo-items/items/cover.png?alt=media');
    expect(
      sanitizeObservedStorageDownloadUrl(
        'https://firebasestorage.googleapis.com:8443/v0/b/demo-items/o/a.png?alt=media',
      ),
    ).toBeUndefined();
    expect(
      sanitizeObservedStorageDownloadUrl('https://storage.googleapis.com:8080/demo-items/a.png'),
    ).toBeUndefined();
    expect(
      sanitizeObservedStorageDownloadUrl('https://demo-items.firebasestorage.app:9443/a.png'),
    ).toBeUndefined();

    expect(
      sanitizeObservedStorageDownloadUrl(
        'https://demo-items.firebasestorage.app/items/cover.png?token=abc',
      ),
    ).toBe('https://demo-items.firebasestorage.app/items/cover.png');

    expect(
      sanitizeObservedStorageDownloadUrl(
        'http://127.0.0.1:9199/v0/b/demo-items.appspot.com/o/a.png?alt=media&token=emu-tok',
      ),
    ).toBe('http://127.0.0.1:9199/v0/b/demo-items.appspot.com/o/a.png?alt=media');

    // Untrusted hosts, non-HTTPS cloud origins, and embedded userinfo are rejected:
    expect(sanitizeObservedStorageDownloadUrl('https://attacker.example/phish')).toBeUndefined();
    expect(sanitizeObservedStorageDownloadUrl('https://evilfirebasestorage.app/a.png')).toBeUndefined();
    expect(
      sanitizeObservedStorageDownloadUrl('http://firebasestorage.googleapis.com/v0/b/demo/o/a.png'),
    ).toBeUndefined();
    expect(
      sanitizeObservedStorageDownloadUrl('https://user:pass@storage.googleapis.com/demo/a.png'),
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
