import { expect, it } from 'bun:test';
import { deleteApp } from '../../src/app/index.js';
import { createAppForSandbox } from '../../src/app/internal.js';
import { initializeSandbox } from 'pyric/sandbox';
import {
  StorageError,
  getMetadata,
  getStorage,
  getStorageSandbox,
  ref,
  updateMetadata,
  uploadBytes,
  uploadBytesResumable,
  type FirebaseStorage,
} from '../../src/storage/index.js';
import { targetOf } from '../../src/storage/service.js';

const ALLOW_ALL_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

interface RecordedCallOutcome {
  readonly threw: boolean;
  readonly threwSynchronously: boolean;
  readonly code: string | null;
}

interface RecordedRefOutcome extends RecordedCallOutcome {
  readonly bucket: string | null;
  readonly fullPath: string | null;
  readonly name: string | null;
  readonly toStringValue: string | null;
}

interface RecordedBucketSpellingCase {
  readonly getStorageOutcome: RecordedCallOutcome;
  readonly rootRef: RecordedRefOutcome | null;
  readonly childRef: RecordedRefOutcome | null;
}

interface ObservedSpellingProjection {
  readonly getStorageThrew: boolean;
  readonly getStorageCode: string | null;
  readonly rootRef: {
    readonly threw: boolean;
    readonly code: string | null;
    readonly bucket: string | null;
    readonly fullPath: string | null;
    readonly name: string | null;
    readonly toStringValue: string | null;
  } | null;
  readonly childRef: {
    readonly threw: boolean;
    readonly code: string | null;
    readonly bucket: string | null;
    readonly fullPath: string | null;
    readonly name: string | null;
    readonly toStringValue: string | null;
  } | null;
}

function projectRecordedSpelling(recorded: RecordedBucketSpellingCase): ObservedSpellingProjection {
  let rootRef: ObservedSpellingProjection['rootRef'] = null;
  if (recorded.rootRef !== null) {
    rootRef = {
      threw: recorded.rootRef.threw,
      code: recorded.rootRef.code,
      bucket: recorded.rootRef.bucket,
      fullPath: recorded.rootRef.fullPath,
      name: recorded.rootRef.name,
      toStringValue: recorded.rootRef.toStringValue,
    };
  }
  let childRef: ObservedSpellingProjection['childRef'] = null;
  if (recorded.childRef !== null) {
    childRef = {
      threw: recorded.childRef.threw,
      code: recorded.childRef.code,
      bucket: recorded.childRef.bucket,
      fullPath: recorded.childRef.fullPath,
      name: recorded.childRef.name,
      toStringValue: recorded.childRef.toStringValue,
    };
  }
  return {
    getStorageThrew: recorded.getStorageOutcome.threw,
    getStorageCode: recorded.getStorageOutcome.code,
    rootRef,
    childRef,
  };
}

function observeSandboxRef(
  storage: FirebaseStorage,
  path?: string,
): NonNullable<ObservedSpellingProjection['rootRef']> {
  try {
    let reference = ref(storage);
    if (path !== undefined) {
      reference = ref(storage, path);
    }
    return {
      threw: false,
      code: null,
      bucket: reference.bucket,
      fullPath: reference.fullPath,
      name: reference.name,
      toStringValue: reference.toString(),
    };
  } catch (error) {
    let code: string | null = null;
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const candidate = (error as { code?: unknown }).code;
      if (typeof candidate === 'string') {
        code = candidate;
      }
    }
    return {
      threw: true,
      code,
      bucket: null,
      fullPath: null,
      name: null,
      toStringValue: null,
    };
  }
}

function observeSandboxSpelling(
  app: Parameters<typeof getStorage>[0],
  bucketUrl?: string,
): ObservedSpellingProjection {
  let storage: FirebaseStorage;
  try {
    if (bucketUrl === undefined) {
      storage = getStorage(app);
    } else {
      storage = getStorage(app, bucketUrl);
    }
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    let code: string | null = null;
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const candidate = (error as { code?: unknown }).code;
      if (typeof candidate === 'string') {
        code = candidate;
      }
    }
    return {
      getStorageThrew: true,
      getStorageCode: code,
      rootRef: null,
      childRef: null,
    };
  }
  return {
    getStorageThrew: false,
    getStorageCode: null,
    rootRef: observeSandboxRef(storage),
    childRef: observeSandboxRef(storage, 'items/a.txt'),
  };
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function registerOracleGetStorageBucketUrlSuite({
  load,
}: {
  load: (name: string) => Record<string, unknown>;
}): void {
  it('client-storage-getstorage-bucket-url: handle caching per spelling, ref/metadata bucket names, and invalid bucketUrl rejection (storage#11, #1519)', async () => {
    const obs = load('client-storage-getstorage-bucket-url.json');
    expect(obs.fetchCalls).toBe(0);

    const sandbox = initializeSandbox({});
    getStorageSandbox(sandbox, {
      dbName: uniqueId('s11-default'),
      rules: ALLOW_ALL_RULES,
    });
    getStorageSandbox(sandbox, {
      dbName: uniqueId('s11-media'),
      bucket: 'media-bucket',
      rules: ALLOW_ALL_RULES,
    });

    const configuredApp = createAppForSandbox(
      sandbox,
      { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
      uniqueId('configured'),
    );
    const secondaryApp = createAppForSandbox(
      sandbox,
      { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
      uniqueId('secondary'),
    );
    const retryProbeApp = createAppForSandbox(
      sandbox,
      { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
      uniqueId('retry'),
    );
    const unconfiguredApp = createAppForSandbox(
      sandbox,
      { projectId: 'demo-storage-probe' },
      uniqueId('unconfigured'),
    );

    try {
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

      expect({
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
      }).toEqual(obs.configuredHandles);

      const recordedSpellings = obs.configuredBucketSpellings as Record<
        string,
        RecordedBucketSpellingCase
      >;
      const actualSpellings: Record<string, ObservedSpellingProjection> = {
        omitted: observeSandboxSpelling(configuredApp),
        emptyString: observeSandboxSpelling(configuredApp, ''),
        ownGs: observeSandboxSpelling(configuredApp, 'gs://buckets-default'),
        ownGsTrailingSlash: observeSandboxSpelling(configuredApp, 'gs://buckets-default/'),
        ownBare: observeSandboxSpelling(configuredApp, 'buckets-default'),
        otherGs: observeSandboxSpelling(configuredApp, 'gs://media-bucket'),
        otherGsTrailingSlash: observeSandboxSpelling(configuredApp, 'gs://media-bucket/'),
        otherBare: observeSandboxSpelling(configuredApp, 'media-bucket'),
        firebaseRootDownloadUrl: observeSandboxSpelling(
          configuredApp,
          'https://firebasestorage.googleapis.com/v0/b/media-bucket/o',
        ),
        cloudStorageRootUrl: observeSandboxSpelling(
          configuredApp,
          'https://storage.googleapis.com/media-bucket',
        ),
      };
      for (const [key, expectedCase] of Object.entries(recordedSpellings)) {
        expect(actualSpellings[key]).toEqual(projectRecordedSpelling(expectedCase));
      }

      const recordedInvalid = obs.invalidBucketUrls as Record<string, RecordedBucketSpellingCase>;
      const actualInvalid: Record<string, ObservedSpellingProjection> = {
        gsWithObjectPath: observeSandboxSpelling(configuredApp, 'gs://media-bucket/sub/path'),
        firebaseObjectDownloadUrl: observeSandboxSpelling(
          configuredApp,
          'https://firebasestorage.googleapis.com/v0/b/media-bucket/o/items%2Fa.txt',
        ),
        cloudStorageObjectUrl: observeSandboxSpelling(
          configuredApp,
          'https://storage.googleapis.com/media-bucket/items/a.txt',
        ),
      };
      for (const [key, expectedCase] of Object.entries(recordedInvalid)) {
        expect(actualInvalid[key]).toEqual(projectRecordedSpelling(expectedCase));
      }

      const unconfiguredObs = obs.unconfiguredStorageBucket as {
        repeatOmittedSameHandle: boolean;
        omitted: RecordedBucketSpellingCase;
        explicitGs: RecordedBucketSpellingCase;
        explicitBare: RecordedBucketSpellingCase;
        invalidGsWithObjectPath: RecordedBucketSpellingCase;
      };
      const unconfiguredDefault = getStorage(unconfiguredApp);
      expect(unconfiguredDefault === getStorage(unconfiguredApp)).toBe(
        unconfiguredObs.repeatOmittedSameHandle,
      );
      expect(observeSandboxSpelling(unconfiguredApp, 'gs://media-bucket')).toEqual(
        projectRecordedSpelling(unconfiguredObs.explicitGs),
      );
      expect(observeSandboxSpelling(unconfiguredApp, 'media-bucket')).toEqual(
        projectRecordedSpelling(unconfiguredObs.explicitBare),
      );
      expect(observeSandboxSpelling(unconfiguredApp, 'gs://media-bucket/sub/path')).toEqual(
        projectRecordedSpelling(unconfiguredObs.invalidGsWithObjectPath),
      );

      // KNOWN DIVERGENCE (zero-config sandbox convenience): production throws
      // storage/no-default-bucket on ref(getStorage(unconfiguredApp)), whereas
      // Pyric falls back to the default sandbox store key 'pyric-default'.
      expect(unconfiguredObs.omitted.getStorageOutcome.threw).toBe(false);
      expect(unconfiguredObs.omitted.rootRef?.code).toBe('storage/no-default-bucket');
      expect(unconfiguredObs.omitted.childRef?.code).toBe('storage/no-default-bucket');
      expect(ref(unconfiguredDefault).bucket).toBe('pyric-default');

      // #1519 + multi-bucket store isolation: default-bucket spellings share
      // the 'pyric-default' store while reporting 'buckets-default' on refs
      // and FullMetadata across uploadBytes, getMetadata, updateMetadata, and
      // uploadBytesResumable; 'media-bucket' spellings share 'media-bucket'.
      expect(targetOf(defaultHandle).bucket).toBe('pyric-default');
      expect(targetOf(ownGsHandle).bucket).toBe('pyric-default');
      expect(targetOf(otherGsHandle).bucket).toBe('media-bucket');

      const defaultUploaded = await uploadBytes(
        ref(defaultHandle, 'items/shared.txt'),
        new Uint8Array([1, 2, 3]),
      );
      expect(defaultUploaded.metadata.bucket).toBe('buckets-default');
      const ownGsMeta = await getMetadata(ref(ownGsHandle, 'items/shared.txt'));
      expect(ownGsMeta.bucket).toBe('buckets-default');
      const ownBareUpdated = await updateMetadata(ref(ownBareHandle, 'items/shared.txt'), {
        contentLanguage: 'en',
      });
      expect(ownBareUpdated.bucket).toBe('buckets-default');

      const resumableSnap = await uploadBytesResumable(
        ref(ownGsSlashHandle, 'items/resumable.txt'),
        new Uint8Array([4, 5]),
      );
      expect(resumableSnap.metadata.bucket).toBe('buckets-default');

      await expect(getMetadata(ref(otherGsHandle, 'items/shared.txt'))).rejects.toMatchObject({
        code: 'storage/object-not-found',
      });

      const mediaUploaded = await uploadBytes(
        ref(otherGsHandle, 'items/media.txt'),
        new Uint8Array([9, 8]),
      );
      expect(mediaUploaded.metadata.bucket).toBe('media-bucket');
      const mediaReadViaBare = await getMetadata(ref(otherBareHandle, 'items/media.txt'));
      expect(mediaReadViaBare.bucket).toBe('media-bucket');
    } finally {
      await Promise.all([
        deleteApp(configuredApp),
        deleteApp(secondaryApp),
        deleteApp(retryProbeApp),
        deleteApp(unconfiguredApp),
      ]);
      sandbox.dispose();
    }
  });
}
