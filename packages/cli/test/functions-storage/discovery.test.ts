import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  ACTIVE_STORAGE_EVENT_TYPES,
  ARCHIVED_EVENT_TYPE,
  DELETED_EVENT_TYPE,
  FINALIZED_EVENT_TYPE,
  METADATA_UPDATED_EVENT_TYPE,
  STORAGE_EVENT_TYPES,
  discoverStorageTriggers,
  inspectStorageTriggers,
  isStorageEventType,
  matchesStorageTriggerBucket,
  storageTriggersFamily,
} from '../../src/functions/storage/discovery.js';
import { rtdbValueTriggerFamily } from '../../src/functions/rtdb/discovery.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const storageFunctions = requireFromConformance(
  'firebase-functions/v2/storage',
) as typeof import('firebase-functions/v2/storage');
const databaseFunctions = requireFromConformance(
  'firebase-functions/v2/database',
) as typeof import('firebase-functions/v2/database');
const paramsModule = requireFromConformance(
  'firebase-functions/params',
) as typeof import('firebase-functions/params');
const firebaseFunctionsDir = dirname(
  requireFromConformance.resolve('firebase-functions/package.json'),
);
const firebaseConfigModule = requireFromConformance(
  join(firebaseFunctionsDir, 'lib/common/config.js'),
) as { resetCache(): void };

describe('firebase-functions/v2/storage trigger discovery', () => {
  test('claims all four google.cloud.storage.object.v1.* event types', () => {
    const {
      onObjectFinalized,
      onObjectDeleted,
      onObjectArchived,
      onObjectMetadataUpdated,
    } = storageFunctions;
    const { onValueCreated } = databaseFunctions;

    const finalized = onObjectFinalized({ bucket: 'media-bucket' }, () => undefined);
    const deleted = onObjectDeleted({ bucket: 'media-bucket' }, () => undefined);
    const archived = onObjectArchived({ bucket: 'media-bucket' }, () => undefined);
    const metadataUpdated = onObjectMetadataUpdated({ bucket: 'media-bucket' }, () => undefined);
    const rtdb = onValueCreated('/items/{id}', () => undefined);

    expect(STORAGE_EVENT_TYPES).toEqual([
      FINALIZED_EVENT_TYPE,
      DELETED_EVENT_TYPE,
      ARCHIVED_EVENT_TYPE,
      METADATA_UPDATED_EVENT_TYPE,
    ]);
    expect(ACTIVE_STORAGE_EVENT_TYPES.has(FINALIZED_EVENT_TYPE)).toBe(true);
    expect(isStorageEventType(FINALIZED_EVENT_TYPE)).toBe(true);
    expect(isStorageEventType(DELETED_EVENT_TYPE)).toBe(true);
    expect(isStorageEventType(ARCHIVED_EVENT_TYPE)).toBe(true);
    expect(isStorageEventType(METADATA_UPDATED_EVENT_TYPE)).toBe(true);
    expect(isStorageEventType('google.firebase.database.ref.v1.created')).toBe(false);
    expect(isStorageEventType(null)).toBe(false);

    expect(storageTriggersFamily.claims(finalized.__endpoint)).toBe(true);
    expect(storageTriggersFamily.claims(deleted.__endpoint)).toBe(true);
    expect(storageTriggersFamily.claims(archived.__endpoint)).toBe(true);
    expect(storageTriggersFamily.claims(metadataUpdated.__endpoint)).toBe(true);
    expect(storageTriggersFamily.claims(rtdb.__endpoint)).toBe(false);

    const allInspected = inspectStorageTriggers(
      { finalized, deleted, archived, metadataUpdated, rtdb },
      { defaultBucket: 'demo-project.appspot.com' },
    );
    expect(allInspected.unsupported).toEqual([]);
    expect(allInspected.triggers.map((item) => ({
      exportName: item.exportName,
      eventType: item.eventType,
      bucket: item.bucket,
      targetsDefaultBucket: item.targetsDefaultBucket,
    }))).toEqual([
      {
        exportName: 'finalized',
        eventType: FINALIZED_EVENT_TYPE,
        bucket: 'media-bucket',
        targetsDefaultBucket: false,
      },
      {
        exportName: 'deleted',
        eventType: DELETED_EVENT_TYPE,
        bucket: 'media-bucket',
        targetsDefaultBucket: false,
      },
      {
        exportName: 'archived',
        eventType: ARCHIVED_EVENT_TYPE,
        bucket: 'media-bucket',
        targetsDefaultBucket: false,
      },
      {
        exportName: 'metadataUpdated',
        eventType: METADATA_UPDATED_EVENT_TYPE,
        bucket: 'media-bucket',
        targetsDefaultBucket: false,
      },
    ]);
  });

  test('activates all four storage lifecycle events and gates custom activeEventTypes subsets', () => {
    const {
      onObjectFinalized,
      onObjectDeleted,
      onObjectArchived,
      onObjectMetadataUpdated,
    } = storageFunctions;
    const finalized = onObjectFinalized({ bucket: 'demo-project.appspot.com' }, () => undefined);
    const deleted = onObjectDeleted({ bucket: 'demo-project.appspot.com' }, () => undefined);
    const archived = onObjectArchived({ bucket: 'demo-project.appspot.com' }, () => undefined);
    const metadataUpdated = onObjectMetadataUpdated(
      { bucket: 'demo-project.appspot.com' },
      () => undefined,
    );

    expect(ACTIVE_STORAGE_EVENT_TYPES.has(FINALIZED_EVENT_TYPE)).toBe(true);
    expect(ACTIVE_STORAGE_EVENT_TYPES.has(DELETED_EVENT_TYPE)).toBe(true);
    expect(ACTIVE_STORAGE_EVENT_TYPES.has(ARCHIVED_EVENT_TYPE)).toBe(true);
    expect(ACTIVE_STORAGE_EVENT_TYPES.has(METADATA_UPDATED_EVENT_TYPE)).toBe(true);

    const active = discoverStorageTriggers(
      { finalized, deleted, archived, metadataUpdated },
      { defaultBucket: 'demo-project.appspot.com' },
    );
    expect(active.map((item) => item.exportName)).toEqual([
      'finalized',
      'deleted',
      'archived',
      'metadataUpdated',
    ]);

    const unsupported = findUnsupportedTriggers(
      { finalized, deleted, archived, metadataUpdated },
      [rtdbValueTriggerFamily, storageTriggersFamily],
    );
    expect(unsupported).toEqual([]);

    const subsetInspected = inspectStorageTriggers(
      { finalized, deleted, archived, metadataUpdated },
      {
        defaultBucket: 'demo-project.appspot.com',
        activeEventTypes: new Set([FINALIZED_EVENT_TYPE]),
      },
    );
    expect(subsetInspected.triggers.map((item) => item.exportName)).toEqual(['finalized']);
    expect(subsetInspected.unsupported).toEqual([
      { exportName: 'deleted', eventType: DELETED_EVENT_TYPE },
      { exportName: 'archived', eventType: ARCHIVED_EVENT_TYPE },
      { exportName: 'metadataUpdated', eventType: METADATA_UPDATED_EVENT_TYPE },
    ]);
  });

  test('distinguishes omitted default bucket, configured default bucket, and custom buckets', () => {
    const { onObjectFinalized } = storageFunctions;
    const prevConfig = process.env.FIREBASE_CONFIG;
    process.env.FIREBASE_CONFIG = JSON.stringify({
      projectId: 'demo-project',
      storageBucket: 'demo-project.appspot.com',
    });
    firebaseConfigModule.resetCache();
    try {
      const implicitDefault = onObjectFinalized(() => undefined);
      const explicitDefault = onObjectFinalized(
        { bucket: 'demo-project.appspot.com' },
        () => undefined,
      );
      const customBucket = onObjectFinalized(
        { bucket: 'backups-bucket', region: 'europe-west1' },
        () => undefined,
      );

      const triggers = discoverStorageTriggers({
        implicitDefault,
        explicitDefault,
        customBucket,
      });

      expect(triggers).toEqual([
        {
          exportName: 'implicitDefault',
          eventType: FINALIZED_EVENT_TYPE,
          bucket: 'demo-project.appspot.com',
          targetsDefaultBucket: true,
          callable: implicitDefault,
        },
        {
          exportName: 'explicitDefault',
          eventType: FINALIZED_EVENT_TYPE,
          bucket: 'demo-project.appspot.com',
          targetsDefaultBucket: true,
          callable: explicitDefault,
        },
        {
          exportName: 'customBucket',
          eventType: FINALIZED_EVENT_TYPE,
          bucket: 'backups-bucket',
          targetsDefaultBucket: false,
          location: 'europe-west1',
          callable: customBucket,
        },
      ]);
    } finally {
      if (prevConfig === undefined) {
        delete process.env.FIREBASE_CONFIG;
      } else {
        process.env.FIREBASE_CONFIG = prevConfig;
      }
      firebaseConfigModule.resetCache();
    }
  });

  test('recursively discovers grouped exports and stops export cycles cleanly', () => {
    const { onObjectFinalized } = storageFunctions;
    const thumb = onObjectFinalized({ bucket: 'assets-bucket' }, () => undefined);
    const grouped: Record<string, unknown> = { generateThumb: thumb };
    grouped.self = grouped;

    const discovered = discoverStorageTriggers({
      images: grouped,
      mirror: { generateThumb: thumb },
    });
    expect(discovered.map((item) => item.exportName)).toEqual([
      'images-generateThumb',
      'mirror-generateThumb',
    ]);
  });

  test('honors omit: true and reports dynamic Expression options as unsupported', () => {
    const { onObjectFinalized } = storageFunctions;
    const { defineBoolean, defineString } = paramsModule;

    const omitted = onObjectFinalized(
      { bucket: 'assets-bucket', omit: true },
      () => undefined,
    );
    const explicitActive = onObjectFinalized(
      { bucket: 'assets-bucket', omit: false, region: ['asia-northeast1', 'us-east1'] },
      () => undefined,
    );
    const dynamicOmit = onObjectFinalized(
      { bucket: 'assets-bucket', omit: defineBoolean('SKIP_THUMB') },
      () => undefined,
    );
    const dynamicBucket = onObjectFinalized(
      { bucket: defineString('TARGET_BUCKET') },
      () => undefined,
    );
    const dynamicRegion = onObjectFinalized(
      { bucket: 'assets-bucket', region: defineString('TARGET_REGION') },
      () => undefined,
    );

    const inspected = inspectStorageTriggers(
      { omitted, explicitActive, dynamicOmit, dynamicBucket, dynamicRegion },
      { activeEventTypes: ACTIVE_STORAGE_EVENT_TYPES },
    );

    expect(inspected.triggers.map((item) => ({
      exportName: item.exportName,
      location: item.location,
    }))).toEqual([
      { exportName: 'explicitActive', location: 'asia-northeast1' },
    ]);
    expect(inspected.unsupported).toEqual([
      {
        exportName: 'omitted',
        eventType: `${FINALIZED_EVENT_TYPE} (omitted from emulation)`,
      },
      {
        exportName: 'dynamicOmit',
        eventType: `${FINALIZED_EVENT_TYPE} (unsupported dynamic omit option)`,
      },
      {
        exportName: 'dynamicBucket',
        eventType: `${FINALIZED_EVENT_TYPE} (unsupported dynamic bucket option)`,
      },
      {
        exportName: 'dynamicRegion',
        eventType: `${FINALIZED_EVENT_TYPE} (unsupported dynamic region option)`,
      },
    ]);
  });

  test('matchesStorageTriggerBucket routes default store aliases and isolates custom buckets', () => {
    const { onObjectFinalized } = storageFunctions;
    const [defaultTrigger, customTrigger] = discoverStorageTriggers(
      {
        onDefault: onObjectFinalized({ bucket: 'demo-project.appspot.com' }, () => undefined),
        onCustom: onObjectFinalized({ bucket: 'exports-bucket' }, () => undefined),
      },
      { defaultBucket: 'demo-project.appspot.com' },
    );
    if (defaultTrigger === undefined || customTrigger === undefined) {
      throw new Error('expected two discovered storage triggers');
    }

    expect(
      matchesStorageTriggerBucket(defaultTrigger, {
        storeBucket: 'pyric-default',
        bucketName: 'pyric-default',
        defaultBucket: 'demo-project.appspot.com',
      }),
    ).toBe(true);
    expect(
      matchesStorageTriggerBucket(defaultTrigger, {
        storeBucket: 'exports-bucket',
        bucketName: 'exports-bucket',
        defaultBucket: 'demo-project.appspot.com',
      }),
    ).toBe(false);
    expect(
      matchesStorageTriggerBucket(customTrigger, {
        storeBucket: 'pyric-default',
        bucketName: 'demo-project.appspot.com',
        defaultBucket: 'demo-project.appspot.com',
      }),
    ).toBe(false);
    expect(
      matchesStorageTriggerBucket(customTrigger, {
        storeBucket: 'exports-bucket',
        bucketName: 'exports-bucket',
        defaultBucket: 'demo-project.appspot.com',
      }),
    ).toBe(true);
  });
});
