import type { Probe } from '../../rigs/types.ts';
import { extractObservedErrorDetails, withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface GetBytesCallOutcome {
  threw: boolean;
  code: string | null;
  errorName: string | null;
  isFirebaseError: boolean;
  isArrayBuffer: boolean;
  byteLength: number | null;
  bytes: number[] | null;
}

export interface StorageGetBytesCapSubject {
  seedPayload(subpath: string, bytes: Uint8Array): Promise<void>;
  readBytes(subpath: string, maxDownloadSizeBytes?: number): Promise<GetBytesCallOutcome>;
}

export async function observeStorageGetBytesRoundtripAndCap(
  subject: StorageGetBytesCapSubject,
): Promise<Record<string, unknown>> {
  const subpath = 'getbytes-cap/payload.bin';
  const payload = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  await subject.seedPayload(subpath, payload);

  const unbounded = await subject.readBytes(subpath);
  const truncatedMax6 = await subject.readBytes(subpath, 6);
  const exactMax16 = await subject.readBytes(subpath, 16);
  const aboveMax32 = await subject.readBytes(subpath, 32);

  return {
    uploadedLength: payload.byteLength,
    unbounded,
    truncatedMax6,
    exactMax16,
    aboveMax32,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'storage#53, #55, #56',
  rowIds: ['storage#53', 'storage#55', 'storage#56'],
  description:
    'firebase/storage getBytes(ref, maxDownloadSize?): observes ArrayBuffer return type and byte fidelity without a cap, truncated prefix return when object exceeds maxDownloadSize, and full-length return when at or under maxDownloadSize.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      return observeStorageGetBytesRoundtripAndCap({
        async seedPayload(subpath, bytes) {
          await storageSdk.uploadBytes(objectRef(subpath), bytes, {
            contentType: 'application/octet-stream',
          });
        },
        async readBytes(subpath, maxDownloadSizeBytes) {
          try {
            let result: ArrayBuffer;
            if (maxDownloadSizeBytes === undefined) {
              result = await storageSdk.getBytes(objectRef(subpath));
            } else {
              result = await storageSdk.getBytes(objectRef(subpath), maxDownloadSizeBytes);
            }
            const isArrayBuffer = result instanceof ArrayBuffer;
            return {
              threw: false,
              code: null,
              errorName: null,
              isFirebaseError: false,
              isArrayBuffer,
              byteLength: result.byteLength,
              bytes: [...new Uint8Array(result)],
            };
          } catch (err) {
            const details = extractObservedErrorDetails(err);
            return {
              threw: true,
              code: details.code,
              errorName: details.errorName,
              isFirebaseError: details.isFirebaseError,
              isArrayBuffer: false,
              byteLength: null,
              bytes: null,
            };
          }
        },
      });
    });
  },
};
