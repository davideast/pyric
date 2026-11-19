/**
 * Served-entry + SharedWorker conformance for `storage#11` and `#1519`
 * (`client-storage-getstorage-bucket-url`).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as ip from 'pyric/storage';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

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

function loadBehavior(name: string): Record<string, unknown> {
  const fileUrl = new URL(
    `../../../../conformance/observations/storage/${name}.json`,
    import.meta.url,
  );
  const parsed = JSON.parse(readFileSync(fileUrl, 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return parsed.behavior;
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

let appSeq = 0;

describe('served entry + SharedWorker getStorage(app, bucketUrl?) parity (storage#11, #1519)', () => {
  let restoreSharedWorker: () => void = () => {};

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSharedWorker = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => {
    restoreSharedWorker();
  });

  test('replays client-storage-getstorage-bucket-url across served SharedWorker handles and per-bucket stores', async () => {
    const obs = loadBehavior('client-storage-getstorage-bucket-url');
    const ctx = await makeHostCtx();
    ip.getStorageSandbox(ctx.sandbox, {
      bucket: 'media-bucket',
    });

    let storageWireMessages = 0;
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          const inbound = event.data as InboundMessage;
          if (
            inbound.t === 'op' &&
            typeof inbound.method === 'string' &&
            inbound.method.startsWith('storage.')
          ) {
            storageWireMessages += 1;
          }
          void handleMessage(ctx, hostPortLike, inbound);
        };
        this.port = clientPort;
      }
    };

    const served = await import('../../../src/serve/entries/storage.js');
    const configuredApp = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
      `served-s11-configured-${++appSeq}`,
    );
    const secondaryApp = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
      `served-s11-secondary-${++appSeq}`,
    );
    const retryProbeApp = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
      `served-s11-retry-${++appSeq}`,
    );
    const unconfiguredApp = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage-probe' },
      `served-s11-unconfigured-${++appSeq}`,
    );

    const observeRef = (
      storage: ip.FirebaseStorage,
      path?: string,
    ): NonNullable<ObservedSpellingProjection['rootRef']> => {
      let reference = served.ref(storage);
      if (path !== undefined) {
        reference = served.ref(storage, path);
      }
      return {
        threw: false,
        code: null,
        bucket: reference.bucket,
        fullPath: reference.fullPath,
        name: reference.name,
        toStringValue: reference.toString(),
      };
    };

    const observeSpelling = (
      targetApp: typeof configuredApp,
      bucketUrl?: string,
    ): ObservedSpellingProjection => {
      let storage: ip.FirebaseStorage;
      try {
        if (bucketUrl === undefined) {
          storage = served.getStorage(targetApp);
        } else {
          storage = served.getStorage(targetApp, bucketUrl);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(served.StorageError);
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
        rootRef: observeRef(storage),
        childRef: observeRef(storage, 'items/a.txt'),
      };
    };

    try {
      const wireBefore = storageWireMessages;

      const defaultHandle = served.getStorage(configuredApp);
      const ownGsHandle = served.getStorage(configuredApp, 'gs://buckets-default');
      const ownGsSlashHandle = served.getStorage(configuredApp, 'gs://buckets-default/');
      const ownBareHandle = served.getStorage(configuredApp, 'buckets-default');
      const emptyBucketUrlHandle = served.getStorage(configuredApp, '');
      const otherGsHandle = served.getStorage(configuredApp, 'gs://media-bucket');
      const otherGsSlashHandle = served.getStorage(configuredApp, 'gs://media-bucket/');
      const otherBareHandle = served.getStorage(configuredApp, 'media-bucket');
      const secondaryOtherGsHandle = served.getStorage(secondaryApp, 'gs://media-bucket');

      const retryDefault = served.getStorage(retryProbeApp);
      const retryOwnGs = served.getStorage(retryProbeApp, 'gs://buckets-default');
      retryOwnGs.maxOperationRetryTime = 45_000;

      expect({
        appMatches: defaultHandle.app === configuredApp && otherGsHandle.app === configuredApp,
        defaultMaxOperationRetryTime: defaultHandle.maxOperationRetryTime,
        defaultMaxUploadRetryTime: defaultHandle.maxUploadRetryTime,
        repeatDefaultSameHandle: defaultHandle === served.getStorage(configuredApp),
        repeatEmptyStringSameHandle: emptyBucketUrlHandle === served.getStorage(configuredApp, ''),
        repeatOwnGsSameHandle:
          ownGsHandle === served.getStorage(configuredApp, 'gs://buckets-default'),
        repeatOtherGsSameHandle:
          otherGsHandle === served.getStorage(configuredApp, 'gs://media-bucket'),
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
        omitted: observeSpelling(configuredApp),
        emptyString: observeSpelling(configuredApp, ''),
        ownGs: observeSpelling(configuredApp, 'gs://buckets-default'),
        ownGsTrailingSlash: observeSpelling(configuredApp, 'gs://buckets-default/'),
        ownBare: observeSpelling(configuredApp, 'buckets-default'),
        otherGs: observeSpelling(configuredApp, 'gs://media-bucket'),
        otherGsTrailingSlash: observeSpelling(configuredApp, 'gs://media-bucket/'),
        otherBare: observeSpelling(configuredApp, 'media-bucket'),
        firebaseRootDownloadUrl: observeSpelling(
          configuredApp,
          'https://firebasestorage.googleapis.com/v0/b/media-bucket/o',
        ),
        cloudStorageRootUrl: observeSpelling(
          configuredApp,
          'https://storage.googleapis.com/media-bucket',
        ),
      };
      for (const [key, expectedCase] of Object.entries(recordedSpellings)) {
        expect(actualSpellings[key]).toEqual(projectRecordedSpelling(expectedCase));
      }

      const recordedInvalid = obs.invalidBucketUrls as Record<string, RecordedBucketSpellingCase>;
      const actualInvalid: Record<string, ObservedSpellingProjection> = {
        gsWithObjectPath: observeSpelling(configuredApp, 'gs://media-bucket/sub/path'),
        firebaseObjectDownloadUrl: observeSpelling(
          configuredApp,
          'https://firebasestorage.googleapis.com/v0/b/media-bucket/o/items%2Fa.txt',
        ),
        cloudStorageObjectUrl: observeSpelling(
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
      const unconfiguredDefault = served.getStorage(unconfiguredApp);
      expect(unconfiguredDefault === served.getStorage(unconfiguredApp)).toBe(
        unconfiguredObs.repeatOmittedSameHandle,
      );
      expect(observeSpelling(unconfiguredApp, 'gs://media-bucket')).toEqual(
        projectRecordedSpelling(unconfiguredObs.explicitGs),
      );
      expect(observeSpelling(unconfiguredApp, 'media-bucket')).toEqual(
        projectRecordedSpelling(unconfiguredObs.explicitBare),
      );
      expect(observeSpelling(unconfiguredApp, 'gs://media-bucket/sub/path')).toEqual(
        projectRecordedSpelling(unconfiguredObs.invalidGsWithObjectPath),
      );
      expect(unconfiguredObs.omitted.rootRef?.code).toBe('storage/no-default-bucket');
      expect(served.ref(unconfiguredDefault).bucket).toBe('pyric-default');

      expect(storageWireMessages - wireBefore).toBe(obs.fetchCalls as number);

      const defaultUploaded = await served.uploadBytes(
        served.ref(defaultHandle, 'items/shared.txt'),
        new Uint8Array([7, 8, 9]),
      );
      expect(defaultUploaded.metadata.bucket).toBe('buckets-default');
      const ownGsRead = await served.getMetadata(served.ref(ownGsHandle, 'items/shared.txt'));
      expect(ownGsRead.bucket).toBe('buckets-default');

      await expect(
        served.getMetadata(served.ref(otherGsHandle, 'items/shared.txt')),
      ).rejects.toMatchObject({ code: 'storage/object-not-found' });

      const mediaUploaded = await served.uploadBytes(
        served.ref(otherGsHandle, 'items/media.txt'),
        new Uint8Array([4, 5]),
      );
      expect(mediaUploaded.metadata.bucket).toBe('media-bucket');
      const mediaBareRead = await served.getMetadata(served.ref(otherBareHandle, 'items/media.txt'));
      expect(mediaBareRead.bucket).toBe('media-bucket');
    } finally {
      await Promise.all([
        deleteApp(configuredApp),
        deleteApp(secondaryApp),
        deleteApp(retryProbeApp),
        deleteApp(unconfiguredApp),
      ]);
      ctx.sandbox.dispose();
    }
  });
});
