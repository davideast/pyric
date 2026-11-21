import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  ARCHIVED_EVENT_TYPE,
  DELETED_EVENT_TYPE,
  FINALIZED_EVENT_TYPE,
  METADATA_UPDATED_EVENT_TYPE,
  discoverStorageTriggers,
} from '../../src/functions/storage/discovery.js';
import {
  buildStorageCloudEvent,
  buildStorageObjectData,
  computeCrc32cBase64,
  computeMd5Base64,
  executeStorageTrigger,
  type StorageObjectSnapshot,
} from '../../src/functions/storage/event.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const storageFunctions = requireFromConformance(
  'firebase-functions/v2/storage',
) as typeof import('firebase-functions/v2/storage');

describe('StorageObjectData and CloudEvent v1.0 encoder', () => {
  test('computes RFC 3720 big-endian Castagnoli crc32c and MD5 base64 digests', () => {
    expect(computeCrc32cBase64(new Uint8Array(0))).toBe('AAAAAA==');
    expect(computeCrc32cBase64(Buffer.from('123456789', 'utf8'))).toBe('4waSgw==');

    expect(computeMd5Base64(new Uint8Array(0))).toBe('1B2M2Y8AsgTpgAmY7PhCfg==');
    expect(computeMd5Base64(Buffer.from('hello world', 'utf8'))).toBe('XrY7u+Ae7tCTyyK7j1rNww==');
  });

  test('encodes fullPath as name, decimal string numeric fields, custom metadata, and optional headers', () => {
    const payload = Buffer.from('avatar-bytes', 'utf8');
    const md5Hash = computeMd5Base64(payload);
    const crc32c = computeCrc32cBase64(payload);
    const snapshot: StorageObjectSnapshot = {
      fullPath: 'users/u-42/avatars/profile.png',
      bucket: 'pyric-default',
      generation: '7',
      metageneration: '2',
      timeCreated: '2026-11-21T12:00:00.000Z',
      updated: '2026-11-21T12:05:00.000Z',
      size: payload.byteLength,
      contentType: 'image/png',
      cacheControl: 'public, max-age=3600',
      contentDisposition: 'inline; filename="profile.png"',
      contentEncoding: 'identity',
      contentLanguage: 'en',
      customMetadata: {
        uploadedBy: 'u-42',
        variant: 'original',
      },
      downloadTokens: 'tok-123',
      md5Hash,
      crc32c,
    };

    const cloudEvent = buildStorageCloudEvent(snapshot, {
      id: 'evt-storage-1',
      time: '2026-11-21T12:05:00.000Z',
      location: 'us-central1',
      eventType: FINALIZED_EVENT_TYPE,
      bucket: 'demo-project.appspot.com',
    });

    expect(cloudEvent).toEqual({
      specversion: '1.0',
      id: 'evt-storage-1',
      source: '//storage.googleapis.com/projects/_/buckets/demo-project.appspot.com',
      subject: 'objects/users/u-42/avatars/profile.png',
      type: FINALIZED_EVENT_TYPE,
      time: '2026-11-21T12:05:00.000Z',
      bucket: 'demo-project.appspot.com',
      location: 'us-central1',
      data: {
        kind: 'storage#object',
        id: 'demo-project.appspot.com/users/u-42/avatars/profile.png/7',
        selfLink:
          'https://www.googleapis.com/storage/v1/b/demo-project.appspot.com/o/users%2Fu-42%2Favatars%2Fprofile.png',
        mediaLink:
          'https://storage.googleapis.com/download/storage/v1/b/demo-project.appspot.com/o/' +
          'users%2Fu-42%2Favatars%2Fprofile.png?generation=7&alt=media',
        name: 'users/u-42/avatars/profile.png',
        bucket: 'demo-project.appspot.com',
        generation: '7',
        metageneration: '2',
        contentType: 'image/png',
        timeCreated: '2026-11-21T12:00:00.000Z',
        updated: '2026-11-21T12:05:00.000Z',
        timeStorageClassUpdated: '2026-11-21T12:00:00.000Z',
        storageClass: 'STANDARD',
        size: String(payload.byteLength),
        md5Hash,
        crc32c,
        etag: Buffer.from('7:2', 'utf8').toString('base64'),
        cacheControl: 'public, max-age=3600',
        contentDisposition: 'inline; filename="profile.png"',
        contentEncoding: 'identity',
        contentLanguage: 'en',
        metadata: {
          uploadedBy: 'u-42',
          variant: 'original',
          firebaseStorageDownloadTokens: 'tok-123',
        },
      },
    });
    expect('timeDeleted' in (cloudEvent.data as Record<string, unknown>)).toBe(false);
  });

  test('omits metadata when customMetadata and downloadTokens are empty, and preserves timeDeleted when present', () => {
    const data = buildStorageObjectData({
      fullPath: 'tmp/zero.bin',
      bucket: 'demo-project.appspot.com',
      generation: '1',
      metageneration: '1',
      timeCreated: '2026-11-21T12:00:00.000Z',
      updated: '2026-11-21T12:00:00.000Z',
      timeDeleted: '2026-11-21T12:10:00.000Z',
      size: 0,
    });

    expect(data.contentType).toBe('application/octet-stream');
    expect(data.size).toBe('0');
    expect(data.md5Hash).toBe('1B2M2Y8AsgTpgAmY7PhCfg==');
    expect(data.crc32c).toBe('AAAAAA==');
    expect(data.timeDeleted).toBe('2026-11-21T12:10:00.000Z');
    expect('metadata' in data).toBe(false);
  });

  test('delivers a real firebase-functions/v2/storage StorageEvent including v1 compat getters', async () => {
    const { onObjectFinalized } = storageFunctions;
    let receivedSummary: Record<string, unknown> | undefined;

    const handler = onObjectFinalized({ bucket: 'demo-project.appspot.com' }, async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const compatEvent = event as unknown as {
        object?: { name?: string; size?: string };
        context?: { eventType?: string; resource?: { service?: string; name?: string } };
      };
      receivedSummary = {
        id: event.id,
        source: event.source,
        specversion: event.specversion,
        type: event.type,
        time: event.time,
        subject: event.subject,
        bucket: event.bucket,
        location: event.location,
        dataName: event.data.name,
        dataBucket: event.data.bucket,
        dataSize: event.data.size,
        dataSizeType: typeof event.data.size,
        dataGeneration: event.data.generation,
        dataMetageneration: event.data.metageneration,
        dataContentType: event.data.contentType,
        dataCrc32c: event.data.crc32c,
        dataMd5Hash: event.data.md5Hash,
        dataMetadata: event.data.metadata,
        compatObjectName: compatEvent.object?.name,
        compatContextEventType: compatEvent.context?.eventType,
        compatResourceName: compatEvent.context?.resource?.name,
      };
      return 'ok-finalized';
    });

    const [trigger] = discoverStorageTriggers(
      { onUpload: handler },
      { defaultBucket: 'demo-project.appspot.com' },
    );
    if (trigger === undefined) {
      throw new Error('expected discovered onUpload trigger');
    }

    const bytes = Buffer.from('123456789', 'utf8');
    const outcome = await executeStorageTrigger(
      trigger,
      {
        fullPath: 'docs/report.txt',
        bucket: 'demo-project.appspot.com',
        generation: '3',
        metageneration: '1',
        timeCreated: '2026-11-21T13:00:00.000Z',
        updated: '2026-11-21T13:00:00.000Z',
        size: bytes.byteLength,
        contentType: 'text/plain',
        customMetadata: { stage: 'raw' },
        md5Hash: computeMd5Base64(bytes),
        crc32c: computeCrc32cBase64(bytes),
      },
      {
        id: 'delivery-99',
        time: '2026-11-21T13:00:00.000Z',
        location: 'europe-west1',
        eventType: FINALIZED_EVENT_TYPE,
        bucket: 'demo-project.appspot.com',
      },
    );

    expect(outcome.status).toBe('fulfilled');
    if (outcome.status === 'fulfilled') {
      expect(outcome.result).toBe('ok-finalized');
    }
    expect(receivedSummary).toEqual({
      id: 'delivery-99',
      source: '//storage.googleapis.com/projects/_/buckets/demo-project.appspot.com',
      specversion: '1.0',
      type: FINALIZED_EVENT_TYPE,
      time: '2026-11-21T13:00:00.000Z',
      subject: 'objects/docs/report.txt',
      bucket: 'demo-project.appspot.com',
      location: 'europe-west1',
      dataName: 'docs/report.txt',
      dataBucket: 'demo-project.appspot.com',
      dataSize: '9',
      dataSizeType: 'string',
      dataGeneration: '3',
      dataMetageneration: '1',
      dataContentType: 'text/plain',
      dataCrc32c: '4waSgw==',
      dataMd5Hash: computeMd5Base64(bytes),
      dataMetadata: { stage: 'raw' },
      compatObjectName: 'docs/report.txt',
      compatContextEventType: 'google.storage.object.finalize',
      compatResourceName: 'projects/_/buckets/demo-project.appspot.com/objects/docs/report.txt#3',
    });
  });

  test('captures rejected handler promises without throwing from executeStorageTrigger', async () => {
    const { onObjectFinalized } = storageFunctions;
    const expectedFailure = new Error('EXPECTED_STORAGE_HANDLER_ERROR');
    const [trigger] = discoverStorageTriggers(
      {
        failing: onObjectFinalized({ bucket: 'demo-project.appspot.com' }, async () => {
          throw expectedFailure;
        }),
      },
      { defaultBucket: 'demo-project.appspot.com' },
    );
    if (trigger === undefined) {
      throw new Error('expected discovered failing trigger');
    }

    const outcome = await executeStorageTrigger(
      trigger,
      {
        fullPath: 'bad/input.bin',
        bucket: 'demo-project.appspot.com',
        generation: '1',
        metageneration: '1',
        timeCreated: '2026-11-21T13:00:00.000Z',
        updated: '2026-11-21T13:00:00.000Z',
        size: 1,
      },
      {
        id: 'delivery-fail',
        time: '2026-11-21T13:00:00.000Z',
        location: 'us-central1',
        eventType: DELETED_EVENT_TYPE,
        bucket: 'demo-project.appspot.com',
      },
    );

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).toBe(expectedFailure);
    }
  });

  test('delivers onObjectDeleted, onObjectArchived, and onObjectMetadataUpdated with upstream v1 compat mappings', async () => {
    const {
      onObjectDeleted,
      onObjectArchived,
      onObjectMetadataUpdated,
    } = storageFunctions;
    const compatRecords: Array<Record<string, unknown>> = [];

    const recordCompat = (label: string) => (event: {
      type: string;
      time: string;
      bucket: string;
      data: {
        name: string;
        generation: string;
        metageneration: string;
        timeDeleted?: string;
        metadata?: Record<string, string>;
      };
    }) => {
      const compat = event as unknown as {
        object?: { name?: string; timeDeleted?: string };
        context?: { eventType?: string; resource?: { name?: string } };
      };
      compatRecords.push({
        label,
        type: event.type,
        time: event.time,
        bucket: event.bucket,
        name: event.data.name,
        generation: event.data.generation,
        metageneration: event.data.metageneration,
        hasTimeDeleted: 'timeDeleted' in event.data,
        timeDeleted: event.data.timeDeleted ?? null,
        hasMetadata: 'metadata' in event.data,
        metadata: event.data.metadata ?? null,
        compatEventType: compat.context?.eventType,
        compatResourceName: compat.context?.resource?.name,
        compatObjectName: compat.object?.name,
      });
    };

    const triggers = discoverStorageTriggers(
      {
        onMeta: onObjectMetadataUpdated({ bucket: 'demo-project.appspot.com' }, recordCompat('meta')),
        onArch: onObjectArchived({ bucket: 'demo-project.appspot.com' }, recordCompat('arch')),
        onDel: onObjectDeleted({ bucket: 'demo-project.appspot.com' }, recordCompat('del')),
      },
      { defaultBucket: 'demo-project.appspot.com' },
    );
    expect(triggers.map((item) => item.exportName)).toEqual(['onMeta', 'onArch', 'onDel']);
    const [metaTrigger, archTrigger, delTrigger] = triggers;
    if (metaTrigger === undefined || archTrigger === undefined || delTrigger === undefined) {
      throw new Error('expected three lifecycle triggers');
    }

    await executeStorageTrigger(
      metaTrigger,
      {
        fullPath: 'notes/readme.txt',
        bucket: 'demo-project.appspot.com',
        generation: '10',
        metageneration: '2',
        timeCreated: '2026-11-21T10:00:00.000Z',
        updated: '2026-11-21T10:05:00.000Z',
        size: 12,
        contentType: 'text/plain',
        customMetadata: { status: 'reviewed' },
      },
      {
        id: 'evt-meta',
        time: '2026-11-21T10:05:00.000Z',
        location: 'us-central1',
        eventType: METADATA_UPDATED_EVENT_TYPE,
        bucket: 'demo-project.appspot.com',
      },
    );

    await executeStorageTrigger(
      archTrigger,
      {
        fullPath: 'notes/readme.txt',
        bucket: 'demo-project.appspot.com',
        generation: '10',
        metageneration: '2',
        timeCreated: '2026-11-21T10:00:00.000Z',
        updated: '2026-11-21T10:05:00.000Z',
        size: 12,
        contentType: 'text/plain',
      },
      {
        id: 'evt-arch',
        time: '2026-11-21T10:06:00.000Z',
        location: 'us-central1',
        eventType: ARCHIVED_EVENT_TYPE,
        bucket: 'demo-project.appspot.com',
      },
    );

    await executeStorageTrigger(
      delTrigger,
      {
        fullPath: 'notes/readme.txt',
        bucket: 'demo-project.appspot.com',
        generation: '11',
        metageneration: '1',
        timeCreated: '2026-11-21T10:06:00.000Z',
        updated: '2026-11-21T10:06:00.000Z',
        timeDeleted: '2026-11-21T10:09:00.000Z',
        size: 20,
        contentType: 'text/plain',
      },
      {
        id: 'evt-del',
        time: '2026-11-21T10:09:00.000Z',
        location: 'us-central1',
        eventType: DELETED_EVENT_TYPE,
        bucket: 'demo-project.appspot.com',
      },
    );

    expect(compatRecords).toEqual([
      {
        label: 'meta',
        type: METADATA_UPDATED_EVENT_TYPE,
        time: '2026-11-21T10:05:00.000Z',
        bucket: 'demo-project.appspot.com',
        name: 'notes/readme.txt',
        generation: '10',
        metageneration: '2',
        hasTimeDeleted: false,
        timeDeleted: null,
        hasMetadata: true,
        metadata: { status: 'reviewed' },
        compatEventType: 'google.storage.object.metadataUpdate',
        compatResourceName: 'projects/_/buckets/demo-project.appspot.com/objects/notes/readme.txt#10',
        compatObjectName: 'notes/readme.txt',
      },
      {
        label: 'arch',
        type: ARCHIVED_EVENT_TYPE,
        time: '2026-11-21T10:06:00.000Z',
        bucket: 'demo-project.appspot.com',
        name: 'notes/readme.txt',
        generation: '10',
        metageneration: '2',
        hasTimeDeleted: false,
        timeDeleted: null,
        hasMetadata: false,
        metadata: null,
        compatEventType: 'google.storage.object.archive',
        compatResourceName: 'projects/_/buckets/demo-project.appspot.com/objects/notes/readme.txt#10',
        compatObjectName: 'notes/readme.txt',
      },
      {
        label: 'del',
        type: DELETED_EVENT_TYPE,
        time: '2026-11-21T10:09:00.000Z',
        bucket: 'demo-project.appspot.com',
        name: 'notes/readme.txt',
        generation: '11',
        metageneration: '1',
        hasTimeDeleted: true,
        timeDeleted: '2026-11-21T10:09:00.000Z',
        hasMetadata: false,
        metadata: null,
        compatEventType: 'google.storage.object.delete',
        compatResourceName: 'projects/_/buckets/demo-project.appspot.com/objects/notes/readme.txt#11',
        compatObjectName: 'notes/readme.txt',
      },
    ]);
  });
});
