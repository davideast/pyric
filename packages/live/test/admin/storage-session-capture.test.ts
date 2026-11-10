/**
 * Metadata-only session capture for `firebase-admin/storage`
 * (`admin/storage-session-capture.ts`): `File.save`, `File.createWriteStream`,
 * `File.getMetadata`, `File.setMetadata`, `File.copy`, `File.move`,
 * `File.delete`, `Bucket.getFiles` (unfiltered vs filtered/paginated),
 * `Bucket.upload`, `Bucket.deleteFiles`, rejection cleanup, verbatim
 * `customMetadata`, and zero binary byte retention.
 */
import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { adminProjectGate } from '../../src/admin/project-gate.js';
import { observeAdminStorage } from '../../src/admin/storage.js';
import type { LiveCallRecord, ObservedSite, ResultReading } from '../../src/observe.js';
import { sessionDataOf } from '../../src/session-data.js';
import {
  adminStorageRejection,
  adminStorageResult,
  adminStorageSessionContext,
  captureAdminWriteStreamDelta,
  extractAdminWriteOptionsMetadata,
} from '../../src/admin/storage-session-capture.js';

function runAdminCapture(
  methodName: string,
  bucket: string,
  path: string | undefined,
  args: readonly unknown[],
  self: unknown,
  resolvedValue: unknown,
) {
  const ctx = adminStorageSessionContext(methodName, bucket, path, args, self);
  const site: ObservedSite = {
    module: '@google-cloud/storage',
    name: `Mock.${methodName}`,
    sdk: 'admin',
    observer: () => undefined,
    bucket,
    sessionData: ctx.sessionData,
  };
  const res = adminStorageResult(site, resolvedValue);
  return { contextDelta: ctx.sessionData, resultReading: res, site };
}

function firstStorageOpOf(reading: ResultReading) {
  if (typeof reading !== 'object') return undefined;
  return reading.sessionData?.storage?.[0];
}

describe('admin/storage-session-capture', () => {
  test('captures File.save and File.createWriteStream metadata with numeric sizes and verbatim customMetadata without holding payload buffers', () => {
    const fileWithServerMeta = {
      name: 'workspaces/ws-1/items/a.txt',
      metadata: {
        size: '11',
        contentType: 'text/plain',
        generation: '1',
        timeCreated: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        metadata: { ownerUid: 'u-1', accessToken: 'secret', sessionId: 's-1' },
      },
    };
    const saved = runAdminCapture(
      'save',
      'demo-proj.firebasestorage.app',
      'workspaces/ws-1/items/a.txt',
      [Buffer.from('hello world'), { contentType: 'text/plain' }],
      fileWithServerMeta,
      undefined,
    );
    expect(saved.resultReading).toEqual({
      sessionData: {
        storage: [
          {
            kind: 'upsert',
            bucket: 'demo-proj.firebasestorage.app',
            fullPath: 'workspaces/ws-1/items/a.txt',
            replaceMetadata: true,
            metadata: {
              size: 11,
              contentType: 'text/plain',
              generation: '1',
              timeCreated: '2026-01-01T00:00:00.000Z',
              updated: '2026-01-01T00:00:00.000Z',
              customMetadata: { ownerUid: 'u-1', accessToken: 'secret', sessionId: 's-1' },
            },
          },
        ],
      },
    });

    const streamOpts = extractAdminWriteOptionsMetadata({
      contentType: 'application/json',
      gzip: true,
      metadata: { metadata: { role: 'export', apiKey: 'secret-k' } },
    });
    const streamDelta = captureAdminWriteStreamDelta(
      'demo-proj.firebasestorage.app',
      'exports/stream.json',
      {},
      64,
      streamOpts,
    );
    expect(streamDelta).toEqual({
      storage: [
        {
          kind: 'upsert',
          bucket: 'demo-proj.firebasestorage.app',
          fullPath: 'exports/stream.json',
          metadata: {
            size: 64,
            contentType: 'application/json',
            contentEncoding: 'gzip',
            customMetadata: { role: 'export', apiKey: 'secret-k' },
          },
        },
      ],
    });
  });

  test('cleans up pending correlation state when an Admin call rejects', () => {
    const ctx = adminStorageSessionContext(
      'save',
      'demo-proj.firebasestorage.app',
      'items/fail.bin',
      [Buffer.from('payload')],
      {},
    );
    const site: ObservedSite = {
      module: '@google-cloud/storage',
      name: 'File.save',
      sdk: 'admin',
      observer: () => undefined,
      bucket: 'demo-proj.firebasestorage.app',
      sessionData: ctx.sessionData,
    };
    expect(adminStorageRejection(site)).toEqual({});
    expect(adminStorageResult(site, undefined)).toEqual({});
  });

  test('captures File.copy, File.move (upsert + source delete), Bucket.upload, File.delete, and Bucket.deleteFiles', () => {
    const moved = runAdminCapture(
      'move',
      'demo-proj.firebasestorage.app',
      'items/draft.png',
      ['items/published.png'],
      { name: 'items/draft.png' },
      [
        { name: 'items/published.png', bucket: { name: 'demo-proj.firebasestorage.app' } },
        { resource: { name: 'items/published.png', bucket: 'demo-proj.firebasestorage.app', size: '512', contentType: 'image/png', generation: '2' } },
      ],
    );
    expect(moved.resultReading).toEqual({
      sessionData: {
        storage: [
          {
            kind: 'upsert',
            bucket: 'demo-proj.firebasestorage.app',
            fullPath: 'items/published.png',
            replaceMetadata: true,
            metadata: { size: 512, contentType: 'image/png', generation: '2' },
          },
          {
            kind: 'delete',
            bucket: 'demo-proj.firebasestorage.app',
            fullPath: 'items/draft.png',
          },
        ],
      },
    });

    const uploaded = runAdminCapture(
      'upload',
      'demo-proj-secondary',
      'exports/report.csv',
      ['/nonexistent/local/report.csv', { destination: 'exports/report.csv' }],
      {},
      [
        { name: 'exports/report.csv', bucket: { name: 'demo-proj-secondary' } },
        { name: 'exports/report.csv', bucket: 'demo-proj-secondary', size: '64', contentType: 'text/csv', generation: '1' },
      ],
    );
    expect(uploaded.resultReading).toEqual({
      sessionData: {
        storage: [
          {
            kind: 'upsert',
            bucket: 'demo-proj-secondary',
            fullPath: 'exports/report.csv',
            replaceMetadata: true,
            metadata: { size: 64, contentType: 'text/csv', generation: '1' },
          },
        ],
      },
    });

    const deleted = runAdminCapture('delete', 'demo-proj.firebasestorage.app', 'items/old.png', [], {}, undefined);
    expect(deleted.contextDelta).toEqual({
      storage: [{ kind: 'delete', bucket: 'demo-proj.firebasestorage.app', fullPath: 'items/old.png' }],
    });

    const deletedPrefix = runAdminCapture(
      'deleteFiles',
      'demo-proj.firebasestorage.app',
      undefined,
      [{ prefix: 'items/archive/' }],
      {},
      undefined,
    );
    expect(deletedPrefix.contextDelta).toEqual({
      storage: [{ kind: 'deletePrefix', bucket: 'demo-proj.firebasestorage.app', prefix: 'items/archive' }],
    });
  });

  test('marks Bucket.getFiles complete only when unpaginated and unfiltered, and emits nothing on File.download or File.exists', () => {
    const unfiltered = runAdminCapture(
      'getFiles',
      'demo-proj.firebasestorage.app',
      undefined,
      [{ prefix: 'workspaces/ws-1/' }],
      {},
      [[{ name: 'workspaces/ws-1/a.png', metadata: { size: '32', contentType: 'image/png' } }], null, {}],
    );
    expect(unfiltered.resultReading).toEqual({
      sessionData: {
        storage: [
          {
            kind: 'list',
            bucket: 'demo-proj.firebasestorage.app',
            prefix: 'workspaces/ws-1',
            prefixes: [],
            items: [{ fullPath: 'workspaces/ws-1/a.png', metadata: { size: 32, contentType: 'image/png' } }],
            complete: true,
            recursive: true,
          },
        ],
      },
    });

    // Filtered queries (`matchGlob`, `versions`, `pageToken`) must NOT claim `complete: true`.
    const globFiltered = runAdminCapture(
      'getFiles',
      'demo-proj.firebasestorage.app',
      undefined,
      [{ prefix: 'workspaces/ws-1/', matchGlob: '**/*.png' }],
      {},
      [[{ name: 'workspaces/ws-1/a.png' }], null, {}],
    );
    const globOp = firstStorageOpOf(globFiltered.resultReading);
    expect(globOp).toEqual({
      kind: 'list',
      bucket: 'demo-proj.firebasestorage.app',
      prefix: 'workspaces/ws-1',
      prefixes: [],
      items: [{ fullPath: 'workspaces/ws-1/a.png' }],
    });

    const paginated = runAdminCapture(
      'getFiles',
      'demo-proj.firebasestorage.app',
      undefined,
      [{ prefix: 'workspaces/ws-1/', maxResults: 1 }],
      {},
      [[{ name: 'workspaces/ws-1/a.png' }], { pageToken: 'next-tok' }, {}],
    );
    const pagedOp = firstStorageOpOf(paginated.resultReading);
    expect(pagedOp?.kind).toBe('list');
    if (pagedOp?.kind === 'list') {
      expect(pagedOp.complete).toBeUndefined();
    }

    const download = runAdminCapture(
      'download',
      'demo-proj.firebasestorage.app',
      'items/a.png',
      [],
      {},
      [Buffer.from([1, 2, 3, 4])],
    );
    expect(download.contextDelta).toBeUndefined();
    expect(download.resultReading).toEqual({});

    const exists = runAdminCapture('exists', 'demo-proj.firebasestorage.app', 'items/a.png', [], {}, [true]);
    expect(exists.contextDelta).toBeUndefined();
    expect(exists.resultReading).toEqual({});

    // Custom non-'/' delimiter must NOT claim `complete: true`.
    const customDelimiter = runAdminCapture(
      'getFiles',
      'demo-proj.firebasestorage.app',
      undefined,
      [{ prefix: 'workspaces:ws-1:', delimiter: ':' }],
      {},
      [[{ name: 'workspaces:ws-1:a.png' }], null, {}],
    );
    const customDelimOp = firstStorageOpOf(customDelimiter.resultReading);
    expect(customDelimOp?.kind).toBe('list');
    if (customDelimOp?.kind === 'list') {
      expect(customDelimOp.complete).toBeUndefined();
    }
  });

  test('File.createWriteStream forwards custom GCS stream events (progress, response, post-open listeners) and emits one metadata-only session upsert', async () => {
    const records: LiveCallRecord[] = [];
    let latestUnderlying: PassThrough | undefined;

    class MockFile {
      readonly name = 'exports/report.bin';
      readonly bucket = {
        name: 'demo-proj.firebasestorage.app',
        storage: { projectId: 'demo-proj' },
      };
      metadata: Record<string, unknown> = {};

      createWriteStream(_options?: Record<string, unknown>): NodeJS.WritableStream {
        const stream = new PassThrough();
        latestUnderlying = stream;
        stream.on('data', (chunk: Buffer) => {
          stream.emit('progress', { bytesWritten: chunk.byteLength });
        });
        stream.on('finish', () => {
          this.metadata = {
            size: '5',
            contentType: 'application/octet-stream',
            generation: '7',
          };
          stream.emit('response', { statusCode: 200 });
          stream.emit('complete', { generation: '7' });
        });
        return stream;
      }
    }

    observeAdminStorage(
      { File: MockFile },
      '/mock/gcs.js',
      {
        observer: (record) => {
          records.push(record);
        },
        gate: adminProjectGate('demo-proj', () => undefined, {}),
      },
    );

    const file = new MockFile();
    const progressEvents: Array<{ bytesWritten: number }> = [];
    const responseEvents: Array<{ statusCode: number }> = [];
    const completeEvents: Array<{ generation: string }> = [];
    let finishCount = 0;

    await new Promise<void>((resolve, reject) => {
      const ws = file.createWriteStream({ contentType: 'application/octet-stream' });
      ws.on('progress', (info: { bytesWritten: number }) => {
        progressEvents.push(info);
      });
      ws.on('response', (resp: { statusCode: number }) => {
        responseEvents.push(resp);
      });
      ws.on('finish', () => {
        finishCount += 1;
        resolve();
      });
      ws.on('error', reject);

      ws.write(Buffer.from('hello'), () => {
        // Attach a custom GCS listener after `underlying` is already open!
        expect(latestUnderlying).toBeDefined();
        ws.on('complete', (meta: { generation: string }) => {
          completeEvents.push(meta);
        });
        ws.end();
      });
    });

    expect(progressEvents).toEqual([{ bytesWritten: 5 }]);
    expect(responseEvents).toEqual([{ statusCode: 200 }]);
    expect(completeEvents).toEqual([{ generation: '7' }]);
    expect(finishCount).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe('File.createWriteStream');
    expect(records[0]?.outcome).toBe('resolved');
    expect(records[0]?.usage?.uploadedBytes).toBe(5);
    expect(sessionDataOf(records[0]!)).toEqual({
      storage: [
        {
          kind: 'upsert',
          bucket: 'demo-proj.firebasestorage.app',
          fullPath: 'exports/report.bin',
          replaceMetadata: true,
          metadata: {
            size: 5,
            contentType: 'application/octet-stream',
            generation: '7',
          },
        },
      ],
    });
  });
});
