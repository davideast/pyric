import { describe, expect, it } from 'bun:test';
import {
  readStorageObjectPath,
  readStorageOp,
  readStoragePrefix,
} from '../../../src/serve/observed-session/storage-delta-validation.js';
import {
  REDACTED_STORAGE_METADATA_VALUE as REDACTED_METADATA_VALUE,
  sanitizeObservedStorageDownloadUrl as sanitizeClientDownloadUrl,
  scrubStorageCustomMetadataRecord as scrubCustomMetadata,
} from '../../../src/serve/observed-session/storage-policy.js';
import { UNREAD_BUCKET } from '../../../src/serve/observed-session/wire.js';

function rejectionReasonOf(raw: unknown): string {
  try {
    readStorageOp(raw, 0);
  } catch (error) {
    if (error instanceof Error && 'reason' in error && typeof error.reason === 'string') {
      return error.reason;
    }
    throw error;
  }
  throw new Error('expected the storage op to be rejected');
}

describe('storage-delta-validation', () => {
  it('accepts valid Storage ops, scrubs secret customMetadata keys/values, and strips query tokens from downloadUrl', () => {
    const upsert = readStorageOp(
      {
        kind: 'upsert',
        bucket: 'demo-proj.firebasestorage.app',
        fullPath: '/workspaces/ws-1/items/item-1.png/',
        replaceMetadata: true,
        metadata: {
          size: 1024,
          contentType: 'image/png',
          cacheControl: 'public, max-age=3600',
          timeCreated: '2026-01-01T00:00:00.000Z',
          updated: '2026-01-01T00:00:05.000Z',
          md5Hash: 'abc123==',
          generation: '1',
          metageneration: '2',
          customMetadata: {
            ownerUid: 'u-1',
            apiKey: 'live-secret-key',
            firebaseStorageDownloadTokens: 'tok-uuid-123',
            accessToken: 'tok-abc',
            userPassword: 'pw',
            uploadPassphrase: 'pp',
            sessionCookie: 'sid=1',
            requestSig: 'sig-1',
          },
        },
      },
      0,
    );

    const list = readStorageOp(
      {
        kind: 'list',
        bucket: UNREAD_BUCKET,
        prefix: '/workspaces/ws-1/',
        prefixes: ['workspaces/ws-1/items/', '/workspaces/ws-1/thumbs'],
        items: [
          {
            fullPath: 'workspaces/ws-1/readme.txt',
            metadata: { size: 12, contentType: 'text/plain' },
          },
        ],
        complete: true,
        recursive: true,
      },
      1,
    );

    const download = readStorageOp(
      {
        kind: 'downloadUrl',
        bucket: 'demo-proj.firebasestorage.app',
        fullPath: 'workspaces/ws-1/items/item-1.png',
        downloadUrl:
          'https://firebasestorage.googleapis.com/v0/b/demo-proj.firebasestorage.app/o/workspaces%2Fws-1%2Fitems%2Fitem-1.png?alt=media&token=pub-1',
      },
      2,
    );

    const del = readStorageOp(
      {
        kind: 'delete',
        bucket: 'demo-proj.firebasestorage.app',
        fullPath: 'workspaces/ws-1/old.png',
      },
      3,
    );

    const delPrefix = readStorageOp(
      {
        kind: 'deletePrefix',
        bucket: 'demo-proj.firebasestorage.app',
        prefix: 'workspaces/ws-1/archive/',
      },
      4,
    );

    expect(upsert).toEqual({
      kind: 'upsert',
      bucket: 'demo-proj.firebasestorage.app',
      fullPath: 'workspaces/ws-1/items/item-1.png',
      replaceMetadata: true,
      metadata: {
        size: 1024,
        contentType: 'image/png',
        cacheControl: 'public, max-age=3600',
        timeCreated: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:05.000Z',
        md5Hash: 'abc123==',
        generation: '1',
        metageneration: '2',
        customMetadata: {
          ownerUid: 'u-1',
          apiKey: REDACTED_METADATA_VALUE,
          firebaseStorageDownloadTokens: REDACTED_METADATA_VALUE,
          accessToken: REDACTED_METADATA_VALUE,
          userPassword: REDACTED_METADATA_VALUE,
          uploadPassphrase: REDACTED_METADATA_VALUE,
          sessionCookie: REDACTED_METADATA_VALUE,
          requestSig: REDACTED_METADATA_VALUE,
        },
      },
    });
    expect(list).toEqual({
      kind: 'list',
      bucket: UNREAD_BUCKET,
      prefix: 'workspaces/ws-1',
      prefixes: ['workspaces/ws-1/items', 'workspaces/ws-1/thumbs'],
      items: [
        {
          fullPath: 'workspaces/ws-1/readme.txt',
          metadata: { size: 12, contentType: 'text/plain' },
        },
      ],
      complete: true,
      recursive: true,
    });
    expect(download).toEqual({
      kind: 'downloadUrl',
      bucket: 'demo-proj.firebasestorage.app',
      fullPath: 'workspaces/ws-1/items/item-1.png',
      downloadUrl:
        'https://firebasestorage.googleapis.com/v0/b/demo-proj.firebasestorage.app/o/workspaces%2Fws-1%2Fitems%2Fitem-1.png?alt=media',
    });
    expect(del).toEqual({
      kind: 'delete',
      bucket: 'demo-proj.firebasestorage.app',
      fullPath: 'workspaces/ws-1/old.png',
    });
    expect(delPrefix).toEqual({
      kind: 'deletePrefix',
      bucket: 'demo-proj.firebasestorage.app',
      prefix: 'workspaces/ws-1/archive',
    });
  });

  it('normalizes object paths and root prefixes cleanly', () => {
    expect(readStorageObjectPath('/items/item-1.png/', 'path')).toBe('items/item-1.png');
    expect(readStoragePrefix('/', 'prefix')).toBe('');
    expect(readStoragePrefix('/items/sub/', 'prefix')).toBe('items/sub');
  });

  it('scrubs broadened secret keys and Bearer/JWT values while preserving ordinary nouns', () => {
    expect(
      scrubCustomMetadata({
        workspaceId: 'ws-1',
        contentAuthor: 'u-1',
        designVariant: 'compact',
        clientSecret: 's1',
        private_key: 'pk',
        Authorization: 'Bearer xyz',
        upstreamHeader: 'Bearer hidden-token-99',
        rawJwtPayload: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJlMTIz',
        firebaseStorageDownloadTokens: 't1,t2',
      }),
    ).toEqual({
      workspaceId: 'ws-1',
      contentAuthor: 'u-1',
      designVariant: 'compact',
      clientSecret: REDACTED_METADATA_VALUE,
      private_key: REDACTED_METADATA_VALUE,
      Authorization: REDACTED_METADATA_VALUE,
      upstreamHeader: REDACTED_METADATA_VALUE,
      rawJwtPayload: REDACTED_METADATA_VALUE,
      firebaseStorageDownloadTokens: REDACTED_METADATA_VALUE,
    });
  });

  it('allowlists Firebase/GCS/loopback origins, strips credential query params, and rejects arbitrary hosts', () => {
    expect(sanitizeClientDownloadUrl('https://attacker.example/phish?alt=media')).toBeUndefined();
    expect(sanitizeClientDownloadUrl('http://storage.googleapis.com/demo-bucket/items/a.png')).toBeUndefined();
    expect(sanitizeClientDownloadUrl('https://user:pass@storage.googleapis.com/items/a.png')).toBeUndefined();
    expect(sanitizeClientDownloadUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeClientDownloadUrl('data:image/png;base64,AAAA')).toBeUndefined();

    expect(
      sanitizeClientDownloadUrl(
        'https://storage.googleapis.com/demo-bucket/items/a.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef&alt=media',
      ),
    ).toBe('https://storage.googleapis.com/demo-bucket/items/a.png?alt=media');

    expect(
      sanitizeClientDownloadUrl(
        'http://127.0.0.1:9199/v0/b/demo.appspot.com/o/items%2Fa.png?alt=media&token=abc&sig=123&se=2099#frag',
      ),
    ).toBe('http://127.0.0.1:9199/v0/b/demo.appspot.com/o/items%2Fa.png?alt=media');

    expect(
      rejectionReasonOf({
        kind: 'downloadUrl',
        bucket: 'demo-bucket',
        fullPath: 'items/a.png',
        downloadUrl: 'https://attacker.example/phish',
      }),
    ).toBe('unsupported');
  });

  it('rejects unknown top-level op fields so unexpected raw payload properties never pass silently', () => {
    expect(
      rejectionReasonOf({
        kind: 'upsert',
        bucket: 'demo-bucket',
        fullPath: 'items/a.png',
        metadata: { size: 10 },
        rawBytes: 'AAAA',
      }),
    ).toBe('unsupported');
    expect(
      rejectionReasonOf({
        kind: 'delete',
        bucket: 'demo-bucket',
        fullPath: 'items/a.png',
        extraField: true,
      }),
    ).toBe('unsupported');
  });

  it('rejects list ops exceeding 250 entries as oversized', () => {
    const items = Array.from({ length: 251 }, (_, idx) => ({
      fullPath: `workspaces/ws-1/items/item-${idx}.png`,
    }));
    expect(
      rejectionReasonOf({
        kind: 'list',
        bucket: 'demo-proj.firebasestorage.app',
        prefix: 'workspaces/ws-1/items',
        prefixes: [],
        items,
      }),
    ).toBe('oversized');
  });

  it('rejects gs:// bucket strings, dot-segment paths, negative sizes, and prototype-pollution keys', () => {
    expect(
      rejectionReasonOf({ kind: 'delete', bucket: 'gs://demo-bucket', fullPath: 'items/a.png' }),
    ).toBe('unsupported');
    expect(
      rejectionReasonOf({ kind: 'delete', bucket: 'demo-bucket', fullPath: 'items/../secret.png' }),
    ).toBe('unsupported');
    expect(
      rejectionReasonOf({
        kind: 'upsert',
        bucket: 'demo-bucket',
        fullPath: 'items/a.png',
        metadata: { size: -1 },
      }),
    ).toBe('unsupported');

    const poisoned = JSON.parse(
      '{"kind":"upsert","bucket":"demo-bucket","fullPath":"items/a.png","metadata":{"customMetadata":{"__proto__":"bad"}}}',
    );
    expect(rejectionReasonOf(poisoned)).toBe('unsupported');
  });
});
