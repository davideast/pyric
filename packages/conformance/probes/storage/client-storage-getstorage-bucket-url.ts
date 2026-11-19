import { FirebaseError, deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  StorageError,
  getStorage,
  ref,
  type FirebaseStorage,
} from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';

interface ObservedErrorShape {
  threw: boolean;
  threwSynchronously: boolean;
  code: string | null;
  errorName: string | null;
  isStorageError: boolean;
  isFirebaseError: boolean;
}

interface ObservedRefOutcome extends ObservedErrorShape {
  bucket: string | null;
  fullPath: string | null;
  name: string | null;
  toStringValue: string | null;
}

interface ObservedBucketSpelling {
  getStorageOutcome: ObservedErrorShape;
  rootRef: ObservedRefOutcome | null;
  childRef: ObservedRefOutcome | null;
}

function noErrorShape(): ObservedErrorShape {
  return {
    threw: false,
    threwSynchronously: false,
    code: null,
    errorName: null,
    isStorageError: false,
    isFirebaseError: false,
  };
}

function errorShapeOf(err: unknown, threwSynchronously: boolean): ObservedErrorShape {
  let code: string | null = null;
  let errorName: string | null = null;
  if (err !== null && typeof err === 'object') {
    const record = err as { code?: unknown; name?: unknown };
    if (typeof record.code === 'string') {
      code = record.code;
    }
    if (typeof record.name === 'string') {
      errorName = record.name;
    }
  }
  return {
    threw: true,
    threwSynchronously,
    code,
    errorName,
    isStorageError: err instanceof StorageError,
    isFirebaseError: err instanceof FirebaseError,
  };
}

function observeRefCall(storage: FirebaseStorage, path?: string): ObservedRefOutcome {
  try {
    let made;
    if (path === undefined) {
      made = ref(storage);
    } else {
      made = ref(storage, path);
    }
    return {
      ...noErrorShape(),
      bucket: made.bucket,
      fullPath: made.fullPath,
      name: made.name,
      toStringValue: made.toString(),
    };
  } catch (err) {
    return {
      ...errorShapeOf(err, true),
      bucket: null,
      fullPath: null,
      name: null,
      toStringValue: null,
    };
  }
}

function observeBucketSpelling(app: FirebaseApp, bucketUrl?: string): ObservedBucketSpelling {
  let storage: FirebaseStorage;
  try {
    if (bucketUrl === undefined) {
      storage = getStorage(app);
    } else {
      storage = getStorage(app, bucketUrl);
    }
  } catch (err) {
    return {
      getStorageOutcome: errorShapeOf(err, true),
      rootRef: null,
      childRef: null,
    };
  }
  return {
    getStorageOutcome: noErrorShape(),
    rootRef: observeRefCall(storage),
    childRef: observeRefCall(storage, 'items/a.txt'),
  };
}

export const probe: Probe = {
  rig: 'client-storage',
  requires: [],
  matrixRow: 'storage#11',
  rowIds: ['storage#11'],
  description:
    'Pure offline firebase/storage getStorage(app, bucketUrl?) handle caching per bucketUrl spelling, ref().bucket and toString() resolution, synchronous storage/invalid-default-bucket validation on URLs with object paths, and unconfigured storageBucket ref() behavior with zero network calls.',
  async observe() {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        fetchCalls += 1;
        throw new Error('Unexpected outbound fetch in offline client-storage probe');
      },
      { preconnect: originalFetch.preconnect },
    );

    const apps: FirebaseApp[] = [];
    const openApp = (options: Record<string, string>, label: string): FirebaseApp => {
      const created = initializeApp(options, `client-storage-bucket-url-${label}`);
      apps.push(created);
      return created;
    };

    try {
      const configuredApp = openApp(
        {
          apiKey: 'fake-api-key',
          projectId: 'demo-storage-probe',
          storageBucket: 'buckets-default',
        },
        'configured',
      );
      const secondaryApp = openApp(
        {
          apiKey: 'fake-api-key',
          projectId: 'demo-storage-probe',
          storageBucket: 'buckets-default',
        },
        'secondary',
      );
      const retryProbeApp = openApp(
        {
          apiKey: 'fake-api-key',
          projectId: 'demo-storage-probe',
          storageBucket: 'buckets-default',
        },
        'retry-isolation',
      );
      const unconfiguredApp = openApp(
        {
          apiKey: 'fake-api-key',
          projectId: 'demo-storage-probe',
        },
        'unconfigured',
      );

      const defaultHandle = getStorage(configuredApp);
      const ownGsHandle = getStorage(configuredApp, 'gs://buckets-default');
      const ownGsSlashHandle = getStorage(configuredApp, 'gs://buckets-default/');
      const ownBareHandle = getStorage(configuredApp, 'buckets-default');
      const emptyBucketUrlHandle = getStorage(configuredApp, '');
      const otherGsHandle = getStorage(configuredApp, 'gs://media-bucket');
      const otherGsSlashHandle = getStorage(configuredApp, 'gs://media-bucket/');
      const otherBareHandle = getStorage(configuredApp, 'media-bucket');
      const secondaryOtherGsHandle = getStorage(secondaryApp, 'gs://media-bucket');

      const retryDefault = getStorage(retryProbeApp);
      const retryOwnGs = getStorage(retryProbeApp, 'gs://buckets-default');
      retryOwnGs.maxOperationRetryTime = 45_000;

      const configuredHandles = {
        appMatches: defaultHandle.app === configuredApp && otherGsHandle.app === configuredApp,
        defaultMaxOperationRetryTime: defaultHandle.maxOperationRetryTime,
        defaultMaxUploadRetryTime: defaultHandle.maxUploadRetryTime,
        repeatDefaultSameHandle: defaultHandle === getStorage(configuredApp),
        repeatEmptyStringSameHandle: emptyBucketUrlHandle === getStorage(configuredApp, ''),
        repeatOwnGsSameHandle: ownGsHandle === getStorage(configuredApp, 'gs://buckets-default'),
        repeatOtherGsSameHandle: otherGsHandle === getStorage(configuredApp, 'gs://media-bucket'),
        defaultEqualsEmptyString: defaultHandle === emptyBucketUrlHandle,
        defaultEqualsOwnGs: defaultHandle === ownGsHandle,
        defaultEqualsOwnGsSlash: defaultHandle === ownGsSlashHandle,
        defaultEqualsOwnBare: defaultHandle === ownBareHandle,
        ownGsEqualsOwnGsSlash: ownGsHandle === ownGsSlashHandle,
        ownGsEqualsOwnBare: ownGsHandle === ownBareHandle,
        otherGsEqualsOtherGsSlash: otherGsHandle === otherGsSlashHandle,
        otherGsEqualsOtherBare: otherGsHandle === otherBareHandle,
        otherAppSameGsDistinctHandle: otherGsHandle !== secondaryOtherGsHandle,
        retryMutationOnOwnGsLeavesDefaultUnchanged:
          retryOwnGs.maxOperationRetryTime === 45_000 &&
          retryDefault.maxOperationRetryTime === 120_000,
      };

      const configuredBucketSpellings = {
        omitted: observeBucketSpelling(configuredApp),
        emptyString: observeBucketSpelling(configuredApp, ''),
        ownGs: observeBucketSpelling(configuredApp, 'gs://buckets-default'),
        ownGsTrailingSlash: observeBucketSpelling(configuredApp, 'gs://buckets-default/'),
        ownBare: observeBucketSpelling(configuredApp, 'buckets-default'),
        otherGs: observeBucketSpelling(configuredApp, 'gs://media-bucket'),
        otherGsTrailingSlash: observeBucketSpelling(configuredApp, 'gs://media-bucket/'),
        otherBare: observeBucketSpelling(configuredApp, 'media-bucket'),
        firebaseRootDownloadUrl: observeBucketSpelling(
          configuredApp,
          'https://firebasestorage.googleapis.com/v0/b/media-bucket/o',
        ),
        cloudStorageRootUrl: observeBucketSpelling(
          configuredApp,
          'https://storage.googleapis.com/media-bucket',
        ),
      };

      const invalidBucketUrls = {
        gsWithObjectPath: observeBucketSpelling(configuredApp, 'gs://media-bucket/sub/path'),
        firebaseObjectDownloadUrl: observeBucketSpelling(
          configuredApp,
          'https://firebasestorage.googleapis.com/v0/b/media-bucket/o/items%2Fa.txt',
        ),
        cloudStorageObjectUrl: observeBucketSpelling(
          configuredApp,
          'https://storage.googleapis.com/media-bucket/items/a.txt',
        ),
      };

      const unconfiguredDefaultHandle = getStorage(unconfiguredApp);
      const unconfiguredStorageBucket = {
        repeatOmittedSameHandle: unconfiguredDefaultHandle === getStorage(unconfiguredApp),
        omitted: observeBucketSpelling(unconfiguredApp),
        explicitGs: observeBucketSpelling(unconfiguredApp, 'gs://media-bucket'),
        explicitBare: observeBucketSpelling(unconfiguredApp, 'media-bucket'),
        invalidGsWithObjectPath: observeBucketSpelling(
          unconfiguredApp,
          'gs://media-bucket/sub/path',
        ),
      };

      return {
        fetchCalls,
        configuredHandles,
        configuredBucketSpellings,
        invalidBucketUrls,
        unconfiguredStorageBucket,
      };
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all(apps.map((created) => deleteApp(created).catch(() => undefined)));
    }
  },
};
