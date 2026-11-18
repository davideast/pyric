import type { Probe } from '../../rigs/types.ts';
import { extractObservedErrorDetails, withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface Base64UrlRoundtripCase {
  contentType: string | null;
  size: number;
  bytes: number[];
}

interface UnknownFormatCallOutcome {
  threw: boolean;
  threwSynchronously: boolean;
  code: string | null;
  errorName: string | null;
  isFirebaseError: boolean;
}

export interface UploadStringBase64UrlSubject {
  uploadBase64UrlAndRead(subpath: string, encoded: string): Promise<Base64UrlRoundtripCase>;
  callUnknownFormat(subpath: string, badFormat: string): Promise<UnknownFormatCallOutcome>;
}

export async function observeUploadStringBase64UrlRoundtrip(
  subject: UploadStringBase64UrlSubject,
): Promise<Record<string, unknown>> {
  const unpaddedUrlSafe = await subject.uploadBase64UrlAndRead(
    'uploadstring-base64url/unpadded.bin',
    '-_8BAg',
  );
  const paddedUrlSafe = await subject.uploadBase64UrlAndRead(
    'uploadstring-base64url/padded.bin',
    '-_8=',
  );
  const unknownFormat = await subject.callUnknownFormat(
    'uploadstring-base64url/unknown.bin',
    'not-a-valid-format',
  );

  return {
    unpaddedUrlSafe,
    paddedUrlSafe,
    unknownFormat,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    "firebase/storage uploadString(ref, value, 'base64url') + unknown format: observes unpadded and padded URL-safe base64 decoding ('-' -> 62, '_' -> 63) round-tripping through getBytes alongside unrecognized format error code and throw timing.",
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      return observeUploadStringBase64UrlRoundtrip({
        async uploadBase64UrlAndRead(subpath, encoded) {
          const targetRef = objectRef(subpath);
          const res = await storageSdk.uploadString(targetRef, encoded, 'base64url');
          const buf = await storageSdk.getBytes(targetRef);
          let contentType: string | null = null;
          if (res.metadata.contentType !== undefined) {
            contentType = res.metadata.contentType;
          }
          return {
            contentType,
            size: res.metadata.size,
            bytes: [...new Uint8Array(buf)],
          };
        },
        async callUnknownFormat(subpath, badFormat) {
          const targetRef = objectRef(subpath);
          let threw = false;
          let threwSynchronously = false;
          let caught: unknown = null;
          try {
            const p = storageSdk.uploadString(
              targetRef,
              'hello',
              badFormat as unknown as 'raw',
            );
            try {
              await p;
            } catch (asyncErr) {
              threw = true;
              caught = asyncErr;
            }
          } catch (syncErr) {
            threw = true;
            threwSynchronously = true;
            caught = syncErr;
          }
          const details = extractObservedErrorDetails(caught);
          return {
            threw,
            threwSynchronously,
            code: details.code,
            errorName: details.errorName,
            isFirebaseError: details.isFirebaseError,
          };
        },
      });
    });
  },
};
