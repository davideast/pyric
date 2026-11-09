/**
 * Metadata-only session capture for client `firebase/storage` calls
 * (`storage-session-capture.ts`): uploads, `getMetadata`, `updateMetadata`,
 * `list` / `listAll` (`<= 250` cap + truncation count), `getDownloadURL`
 * origin allowlisting + credential stripping, `deleteObject`, secret
 * `customMetadata` redaction, and zero binary byte retention on `getBytes`,
 * `getBlob`, and `getStream`.
 */
import { describe, expect, test } from 'bun:test';
import { wrapLiveModule, type LiveCallRecord } from '../src/index.js';
import type { ObservedSite } from '../src/observe.js';
import { sessionDataOf } from '../src/session-data.js';
import {
  sanitizeStorageDownloadUrl,
  scrubStorageCustomMetadata,
  storageSessionContext,
  storageSessionResult,
} from '../src/storage-session-capture.js';

const REDACTED_METADATA_VALUE = '[REDACTED]';

function makeSite(
  name: string,
  bucket = 'demo-proj.firebasestorage.app',
  path?: string,
  writeData?: Record<string, unknown>,
): ObservedSite {
  const site: {
    module: string;
    name: string;
    observer: () => void;
    bucket: string;
    path?: string;
    writeData?: Record<string, unknown>;
  } = {
    module: 'firebase/storage',
    name,
    observer: () => undefined,
    bucket,
  };
  if (path !== undefined) site.path = path;
  if (writeData !== undefined) site.writeData = writeData;
  return site;
}

describe('storage-session-capture', () => {
  test('captures uploadBytes, uploadBytesResumable, and uploadString response metadata while scrubbing secret customMetadata keys and values', () => {
    const delta = storageSessionResult(
      makeSite('uploadBytes', 'demo-proj.firebasestorage.app', 'workspaces/ws-1/items/item-1.png'),
      {
        ref: { bucket: 'demo-proj.firebasestorage.app', fullPath: 'workspaces/ws-1/items/item-1.png' },
        metadata: {
          bucket: 'demo-proj.firebasestorage.app',
          fullPath: 'workspaces/ws-1/items/item-1.png',
          size: 2048,
          contentType: 'image/png',
          cacheControl: 'public, max-age=300',
          md5Hash: 'xyz==',
          generation: '10',
          metageneration: '1',
          timeCreated: '2026-01-01T00:00:00.000Z',
          updated: '2026-01-01T00:00:00.000Z',
          customMetadata: {
            workspaceId: 'ws-1',
            firebaseStorageDownloadTokens: 'tok-live-1',
            apiKey: 'sec-key',
            uploadPassphrase: 'pp-1',
            sessionCookie: 'sid=abc',
            upstreamHeader: 'Bearer live-bearer-123',
          },
        },
      },
    );

    expect(delta).toEqual({
      storage: [
        {
          kind: 'upsert',
          bucket: 'demo-proj.firebasestorage.app',
          fullPath: 'workspaces/ws-1/items/item-1.png',
          replaceMetadata: true,
          metadata: {
            size: 2048,
            contentType: 'image/png',
            cacheControl: 'public, max-age=300',
            md5Hash: 'xyz==',
            generation: '10',
            metageneration: '1',
            timeCreated: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            customMetadata: {
              workspaceId: 'ws-1',
              firebaseStorageDownloadTokens: REDACTED_METADATA_VALUE,
              apiKey: REDACTED_METADATA_VALUE,
              uploadPassphrase: REDACTED_METADATA_VALUE,
              sessionCookie: REDACTED_METADATA_VALUE,
              upstreamHeader: REDACTED_METADATA_VALUE,
            },
          },
        },
      ],
    });
  });

  test('falls back to metadata-only writeData when an upload result carries no server metadata', () => {
    const delta = storageSessionResult(
      makeSite('uploadString', 'demo-proj.firebasestorage.app', 'items/note.txt', {
        size: 12,
        contentType: 'text/plain',
        customMetadata: { ownerUid: 'u-1', passwordHint: 'secret' },
      }),
      {},
    );

    expect(delta).toEqual({
      storage: [
        {
          kind: 'upsert',
          bucket: 'demo-proj.firebasestorage.app',
          fullPath: 'items/note.txt',
          metadata: {
            size: 12,
            contentType: 'text/plain',
            customMetadata: {
              ownerUid: 'u-1',
              passwordHint: REDACTED_METADATA_VALUE,
            },
          },
        },
      ],
    });
  });

  test('captures listAll and paginated list prefixes/items up to 250 entries and records truncation overflow', () => {
    const items = Array.from({ length: 252 }, (_, idx) => ({
      bucket: 'demo-proj.firebasestorage.app',
      fullPath: `workspaces/ws-1/items/item-${idx}.png`,
    }));

    const truncatedList = storageSessionResult(
      makeSite('listAll', 'demo-proj.firebasestorage.app', 'workspaces/ws-1'),
      {
        prefixes: [{ bucket: 'demo-proj.firebasestorage.app', fullPath: 'workspaces/ws-1/items' }],
        items,
      },
    );

    expect(truncatedList?.storage?.[0]).toMatchObject({
      kind: 'list',
      bucket: 'demo-proj.firebasestorage.app',
      prefix: 'workspaces/ws-1',
      prefixes: ['workspaces/ws-1/items'],
    });
    const listOp = truncatedList?.storage?.[0];
    if (listOp?.kind === 'list') {
      expect(listOp.items).toHaveLength(249);
      expect(listOp.complete).toBeUndefined();
    }
    expect(truncatedList?.skipped).toEqual({ truncated: 3 });

    const pagedList = storageSessionResult(
      makeSite('list', 'demo-proj.firebasestorage.app', 'workspaces/ws-1'),
      {
        prefixes: [],
        items: [{ fullPath: 'workspaces/ws-1/a.png' }],
        nextPageToken: 'page-2',
      },
    );
    expect(pagedList).toEqual({
      storage: [
        {
          kind: 'list',
          bucket: 'demo-proj.firebasestorage.app',
          prefix: 'workspaces/ws-1',
          prefixes: [],
          items: [{ fullPath: 'workspaces/ws-1/a.png' }],
        },
      ],
    });
  });

  test('strips bearer token= and signed query params from allowlisted getDownloadURL hosts while rejecting phishing origins and byte downloads', () => {
    const rawDownloadUrl =
      'https://firebasestorage.googleapis.com/v0/b/demo-proj.firebasestorage.app/o/items%2Fa.png?alt=media&token=pub-1';
    expect(
      storageSessionResult(makeSite('getDownloadURL', 'demo-proj.firebasestorage.app', 'items/a.png'), rawDownloadUrl),
    ).toEqual({
      storage: [
        {
          kind: 'downloadUrl',
          bucket: 'demo-proj.firebasestorage.app',
          fullPath: 'items/a.png',
          downloadUrl:
            'https://firebasestorage.googleapis.com/v0/b/demo-proj.firebasestorage.app/o/items%2Fa.png?alt=media',
        },
      ],
    });

    expect(
      storageSessionResult(
        makeSite('getDownloadURL', 'demo-proj.firebasestorage.app', 'items/a.png'),
        'https://attacker.example/phish?alt=media',
      ),
    ).toEqual({ skipped: { unsupported: 1 } });

    expect(sanitizeStorageDownloadUrl('data:text/plain;base64,SGVsbG8=')).toBeUndefined();
    expect(scrubStorageCustomMetadata({ secretToken: 'abc', label: 'ok' })).toEqual({
      secretToken: REDACTED_METADATA_VALUE,
      label: 'ok',
    });

    const rawBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(storageSessionResult(makeSite('getBytes', 'demo-proj.firebasestorage.app', 'items/a.png'), rawBytes)).toBeUndefined();
    expect(storageSessionResult(makeSite('getBlob', 'demo-proj.firebasestorage.app', 'items/a.png'), new Blob(['abc']))).toBeUndefined();
    expect(storageSessionResult(makeSite('getStream', 'demo-proj.firebasestorage.app', 'items/a.png'), undefined)).toBeUndefined();
  });

  test('captures deleteObject in storageSessionContext', () => {
    expect(storageSessionContext('deleteObject', 'demo-proj.firebasestorage.app', 'items/a.png')).toEqual({
      storage: [{ kind: 'delete', bucket: 'demo-proj.firebasestorage.app', fullPath: 'items/a.png' }],
    });
    expect(storageSessionContext('getMetadata', 'demo-proj.firebasestorage.app', 'items/a.png')).toBeUndefined();
  });

  test('marks client list() complete only on unpaginated single-page requests without pageToken', async () => {
    const records: LiveCallRecord[] = [];
    const mockStorageSdk = {
      async list(
        _ref: { bucket: string; fullPath: string },
        options?: { maxResults?: number; pageToken?: string },
      ) {
        if (options?.pageToken === 'tok-1') {
          // Final page of a multi-page walk: nextPageToken is undefined, but request had pageToken!
          return {
            prefixes: [],
            items: [{ bucket: 'demo-proj.firebasestorage.app', fullPath: 'items/3.png' }],
          };
        }
        if (options?.maxResults === 2) {
          return {
            prefixes: [],
            items: [
              { bucket: 'demo-proj.firebasestorage.app', fullPath: 'items/1.png' },
              { bucket: 'demo-proj.firebasestorage.app', fullPath: 'items/2.png' },
            ],
            nextPageToken: 'tok-1',
          };
        }
        return {
          prefixes: [],
          items: [
            { bucket: 'demo-proj.firebasestorage.app', fullPath: 'items/1.png' },
            { bucket: 'demo-proj.firebasestorage.app', fullPath: 'items/3.png' },
          ],
        };
      },
    };

    const wrapped = wrapLiveModule('live-storage', 'firebase/storage', mockStorageSdk, {
      observer: (record) => {
        records.push(record);
      },
      sdkVersion: '12.0.0',
      client: 'node',
    });

    const folderRef = { bucket: 'demo-proj.firebasestorage.app', fullPath: 'items' };
    await wrapped.list(folderRef, { maxResults: 2 });
    await wrapped.list(folderRef, { maxResults: 2, pageToken: 'tok-1' });
    await wrapped.list(folderRef, { maxResults: 10 });

    expect(records).toHaveLength(3);
    const page1Op = sessionDataOf(records[0]!)?.storage?.[0];
    const page2Op = sessionDataOf(records[1]!)?.storage?.[0];
    const singlePageOp = sessionDataOf(records[2]!)?.storage?.[0];

    expect(page1Op).toMatchObject({ kind: 'list', prefix: 'items' });
    expect(page2Op).toMatchObject({ kind: 'list', prefix: 'items' });
    expect(singlePageOp).toMatchObject({ kind: 'list', prefix: 'items', complete: true });
    if (page1Op?.kind === 'list') expect(page1Op.complete).toBeUndefined();
    if (page2Op?.kind === 'list') expect(page2Op.complete).toBeUndefined();
  });
});
