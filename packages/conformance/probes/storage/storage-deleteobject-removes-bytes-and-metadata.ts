import type { Probe } from '../../rigs/types.ts';
import { extractObservedErrorDetails, withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface DeleteBytesReadOutcome {
  threw: boolean;
  code: string | null;
  errorName: string | null;
  isFirebaseError: boolean;
  byteLength: number | null;
  bytes: number[] | null;
}

interface DeleteMetadataReadOutcome {
  threw: boolean;
  code: string | null;
  errorName: string | null;
  isFirebaseError: boolean;
  size: number | null;
  contentType: string | null;
  customMetadata: Record<string, string> | null;
}

export interface StorageDeleteAtomicSubject {
  seedObject(
    subpath: string,
    bytes: Uint8Array,
    contentType: string,
    customMetadata: Record<string, string>,
  ): Promise<void>;
  readBytes(subpath: string): Promise<DeleteBytesReadOutcome>;
  readMetadata(subpath: string): Promise<DeleteMetadataReadOutcome>;
  deleteTarget(subpath: string): Promise<{ resolvedUndefined: boolean }>;
}

export async function observeStorageDeleteRemovesBytesAndMetadata(
  subject: StorageDeleteAtomicSubject,
): Promise<Record<string, unknown>> {
  const subpath = 'delete-atomic/item.bin';
  const payload = new Uint8Array([16, 32, 48, 64]);
  await subject.seedObject(subpath, payload, 'application/octet-stream', { tag: 'ephemeral' });

  const beforeDeleteBytes = await subject.readBytes(subpath);
  const beforeDeleteMetadata = await subject.readMetadata(subpath);
  const deleteCall = await subject.deleteTarget(subpath);
  const afterDeleteBytes = await subject.readBytes(subpath);
  const afterDeleteMetadata = await subject.readMetadata(subpath);

  return {
    beforeDeleteBytes,
    beforeDeleteMetadata,
    deleteResolvedUndefined: deleteCall.resolvedUndefined,
    afterDeleteBytes,
    afterDeleteMetadata,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'storage#63',
  rowIds: ['storage#63'],
  description:
    'firebase/storage deleteObject(ref): observes atomic removal of both stored bytes and object metadata so post-delete getBytes and getMetadata both reject with storage/object-not-found.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      return observeStorageDeleteRemovesBytesAndMetadata({
        async seedObject(subpath, bytes, contentType, customMetadata) {
          await storageSdk.uploadBytes(objectRef(subpath), bytes, {
            contentType,
            customMetadata,
          });
        },
        async readBytes(subpath) {
          try {
            const buf = await storageSdk.getBytes(objectRef(subpath));
            return {
              threw: false,
              code: null,
              errorName: null,
              isFirebaseError: false,
              byteLength: buf.byteLength,
              bytes: [...new Uint8Array(buf)],
            };
          } catch (err) {
            const details = extractObservedErrorDetails(err);
            return {
              threw: true,
              code: details.code,
              errorName: details.errorName,
              isFirebaseError: details.isFirebaseError,
              byteLength: null,
              bytes: null,
            };
          }
        },
        async readMetadata(subpath) {
          try {
            const meta = await storageSdk.getMetadata(objectRef(subpath));
            let customMetadata: Record<string, string> | null = null;
            if (meta.customMetadata !== undefined) {
              customMetadata = meta.customMetadata;
            }
            let contentType: string | null = null;
            if (meta.contentType !== undefined) {
              contentType = meta.contentType;
            }
            return {
              threw: false,
              code: null,
              errorName: null,
              isFirebaseError: false,
              size: meta.size,
              contentType,
              customMetadata,
            };
          } catch (err) {
            const details = extractObservedErrorDetails(err);
            return {
              threw: true,
              code: details.code,
              errorName: details.errorName,
              isFirebaseError: details.isFirebaseError,
              size: null,
              contentType: null,
              customMetadata: null,
            };
          }
        },
        async deleteTarget(subpath) {
          const out = await storageSdk.deleteObject(objectRef(subpath));
          return { resolvedUndefined: out === undefined };
        },
      });
    });
  },
};
