import { describe, expect, it } from 'bun:test';
import {
  readStorageObjectPath,
  readStorageOp,
  readStoragePrefix,
} from '../../../src/serve/observed-session/storage-delta-validation.js';
import {
  copyStorageCustomMetadataRecord,
  validateObservedStorageDownloadUrl,
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
  it('accepts valid Storage ops and preserves customMetadata and downloadUrl query parameters verbatim', () => {
    const customMetadata = {
      ownerUid: 'u-1',
      apiKey: 'live-secret-key',
      firebaseStorageDownloadTokens: 'tok-example-123',
      accessToken: 'tok-abc',
      userPassword: 'pw',
      uploadPassphrase: 'pp',
      sessionCookie: 'sid=1',
      requestSig: 'sig-1',
    };
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
          customMetadata,
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
        customMetadata,
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
        'https://firebasestorage.googleapis.com/v0/b/demo-proj.firebasestorage.app/o/workspaces%2Fws-1%2Fitems%2Fitem-1.png?alt=media&token=pub-1',
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

  it('preserves all customMetadata entries verbatim while dropping prototype-pollution keys', () => {
    const entries = {
      workspaceId: 'ws-1',
      contentAuthor: 'u-1',
      designVariant: 'compact',
      clientSecret: 's1',
      private_key: 'pk',
      Authorization: 'Bearer xyz',
      upstreamHeader: 'Bearer hidden-token-99',
      rawJwtPayload: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJlMTIz',
      firebaseStorageDownloadTokens: 't1,t2',
    };
    expect(copyStorageCustomMetadataRecord(entries)).toEqual(entries);
  });

  it('allowlists Firebase/GCS/loopback origins, preserves query parameters, and rejects arbitrary hosts', () => {
    expect(validateObservedStorageDownloadUrl('https://attacker.example/phish?alt=media')).toBeUndefined();
    expect(validateObservedStorageDownloadUrl('http://storage.googleapis.com/demo-bucket/items/a.png')).toBeUndefined();
    expect(validateObservedStorageDownloadUrl('https://user:pass@storage.googleapis.com/items/a.png')).toBeUndefined();
    expect(validateObservedStorageDownloadUrl('javascript:alert(1)')).toBeUndefined();
    expect(validateObservedStorageDownloadUrl('data:image/png;base64,AAAA')).toBeUndefined();

    const signedUrl =
      'https://storage.googleapis.com/demo-bucket/items/a.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef&alt=media';
    expect(validateObservedStorageDownloadUrl(signedUrl)).toBe(signedUrl);

    const loopbackUrl =
      'http://127.0.0.1:9199/v0/b/demo.appspot.com/o/items%2Fa.png?alt=media&token=abc&sig=123&se=2099#frag';
    expect(validateObservedStorageDownloadUrl(loopbackUrl)).toBe(loopbackUrl);

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
