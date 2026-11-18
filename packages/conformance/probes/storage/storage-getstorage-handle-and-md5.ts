import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

export interface GetStorageMd5Subject {
  inspectHandlesAndRetryTimes(): Promise<{
    sameAppIdentityStable: boolean;
    differentAppDistinctHandle: boolean;
    appPropertyMatches: boolean;
    defaultMaxOperationRetryTime: number;
    defaultMaxUploadRetryTime: number;
    updatedMaxOperationRetryTime: number;
    updatedMaxUploadRetryTime: number;
  }>;
  uploadAndReadMd5(
    subpath: string,
    bytes: Uint8Array,
  ): Promise<{
    uploadMd5: string | null;
    getMetadataMd5: string | null;
    readBackBytes: number[];
  }>;
}

export async function observeStorageGetStorageAndMd5(
  subject: GetStorageMd5Subject,
): Promise<Record<string, unknown>> {
  const handles = await subject.inspectHandlesAndRetryTimes();
  const emptyOut = await subject.uploadAndReadMd5(
    'getstorage-md5/empty.bin',
    new Uint8Array([]),
  );
  const fourByteOut = await subject.uploadAndReadMd5(
    'getstorage-md5/four.bin',
    new Uint8Array([1, 2, 3, 4]),
  );

  return {
    ...handles,
    emptyPayloadMd5OnUpload: emptyOut.uploadMd5,
    emptyPayloadMd5OnGetMetadata: emptyOut.getMetadataMd5,
    emptyPayloadMd5MatchesUploadAndGet:
      emptyOut.uploadMd5 !== null && emptyOut.uploadMd5 === emptyOut.getMetadataMd5,
    fourBytePayloadMd5OnUpload: fourByteOut.uploadMd5,
    fourBytePayloadMd5OnGetMetadata: fourByteOut.getMetadataMd5,
    fourBytePayloadMd5MatchesUploadAndGet:
      fourByteOut.uploadMd5 !== null &&
      fourByteOut.uploadMd5 === fourByteOut.getMetadataMd5,
    roundtripBytes: fourByteOut.readBackBytes,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase/storage getStorage(app) + FullMetadata.md5Hash: observes per-app handle identity, retry-time properties, round-trip upload/read via getStorage(app), and base64 MD5 digests on empty and non-empty uploads.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storage, storageBucket, storageSdk }) => {
      const { deleteApp, initializeApp } = await import('firebase/app');
      return observeStorageGetStorageAndMd5({
        async inspectHandlesAndRetryTimes() {
          const app = storage.app;
          const first = storageSdk.getStorage(app);
          const second = storageSdk.getStorage(app);
          const secondaryApp = initializeApp(
            { ...app.options, storageBucket },
            `${app.name}-secondary`,
          );
          try {
            const secondaryStorage = storageSdk.getStorage(secondaryApp);
            const defaultMaxOperationRetryTime = first.maxOperationRetryTime;
            const defaultMaxUploadRetryTime = first.maxUploadRetryTime;
            first.maxOperationRetryTime = 45000;
            first.maxUploadRetryTime = 180000;
            const updatedMaxOperationRetryTime = first.maxOperationRetryTime;
            const updatedMaxUploadRetryTime = first.maxUploadRetryTime;
            first.maxOperationRetryTime = defaultMaxOperationRetryTime;
            first.maxUploadRetryTime = defaultMaxUploadRetryTime;
            return {
              sameAppIdentityStable: first === second && first === storage,
              differentAppDistinctHandle: first !== secondaryStorage,
              appPropertyMatches: first.app === app,
              defaultMaxOperationRetryTime,
              defaultMaxUploadRetryTime,
              updatedMaxOperationRetryTime,
              updatedMaxUploadRetryTime,
            };
          } finally {
            await deleteApp(secondaryApp);
          }
        },
        async uploadAndReadMd5(subpath, bytes) {
          const targetRef = objectRef(subpath);
          const uploaded = await storageSdk.uploadBytes(targetRef, bytes, {
            contentType: 'application/octet-stream',
          });
          const fetchedMeta = await storageSdk.getMetadata(targetRef);
          const buf = await storageSdk.getBytes(targetRef);
          let uploadMd5: string | null = null;
          if (typeof uploaded.metadata.md5Hash === 'string') {
            uploadMd5 = uploaded.metadata.md5Hash;
          }
          let getMetadataMd5: string | null = null;
          if (typeof fetchedMeta.md5Hash === 'string') {
            getMetadataMd5 = fetchedMeta.md5Hash;
          }
          return {
            uploadMd5,
            getMetadataMd5,
            readBackBytes: [...new Uint8Array(buf)],
          };
        },
      });
    });
  },
};
