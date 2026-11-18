import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface UploadedPayloadObservation {
  resultRefFullPath: string;
  metadataFullPath: string;
  metadataName: string;
  metadataBucket: string;
  metadataSize: number;
  readBytes: number[];
}

export interface StorageUploadPayloadTypesSubject {
  expectedBucket: string;
  uploadAndReadBack(
    subpath: string,
    data: Blob | Uint8Array | ArrayBuffer,
  ): Promise<{
    expectedFullPath: string;
    expectedName: string;
    observed: UploadedPayloadObservation;
  }>;
  scrubRunPath(text: string): string;
}

function summarizePayloadCase(
  expectedBucket: string,
  expectedFullPath: string,
  expectedName: string,
  observed: UploadedPayloadObservation,
  scrubRunPath: (text: string) => string,
): Record<string, unknown> {
  return {
    scrubbedFullPath: scrubRunPath(observed.metadataFullPath),
    resultRefMatchesTarget: observed.resultRefFullPath === expectedFullPath,
    metadataFullPathMatchesTarget: observed.metadataFullPath === expectedFullPath,
    metadataNameMatchesTarget: observed.metadataName === expectedName,
    metadataName: observed.metadataName,
    metadataBucketMatchesHandle: observed.metadataBucket === expectedBucket,
    metadataBucketNonEmpty: observed.metadataBucket.length > 0,
    metadataSize: observed.metadataSize,
    readBytes: observed.readBytes,
  };
}

export async function observeUploadBytesPayloadTypes(
  subject: StorageUploadPayloadTypesSubject,
): Promise<Record<string, unknown>> {
  const rawBytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
  const blobInput = new Blob([rawBytes], { type: 'application/octet-stream' });
  const uint8Input = new Uint8Array(rawBytes);
  const arrayBufferInput = rawBytes.buffer.slice(
    rawBytes.byteOffset,
    rawBytes.byteOffset + rawBytes.byteLength,
  );

  const blobOutcome = await subject.uploadAndReadBack('uploadbytes-payloads/from-blob.bin', blobInput);
  const uint8Outcome = await subject.uploadAndReadBack(
    'uploadbytes-payloads/from-uint8array.bin',
    uint8Input,
  );
  const arrayBufferOutcome = await subject.uploadAndReadBack(
    'uploadbytes-payloads/from-arraybuffer.bin',
    arrayBufferInput,
  );

  return {
    inputBytes: Array.from(rawBytes),
    blobPayload: summarizePayloadCase(
      subject.expectedBucket,
      blobOutcome.expectedFullPath,
      blobOutcome.expectedName,
      blobOutcome.observed,
      subject.scrubRunPath,
    ),
    uint8ArrayPayload: summarizePayloadCase(
      subject.expectedBucket,
      uint8Outcome.expectedFullPath,
      uint8Outcome.expectedName,
      uint8Outcome.observed,
      subject.scrubRunPath,
    ),
    arrayBufferPayload: summarizePayloadCase(
      subject.expectedBucket,
      arrayBufferOutcome.expectedFullPath,
      arrayBufferOutcome.expectedName,
      arrayBufferOutcome.observed,
      subject.scrubRunPath,
    ),
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'storage#24',
  rowIds: ['storage#24', 'storage#25', 'storage#26', 'storage#32', 'storage#33', 'storage#34'],
  description:
    'uploadBytes accepts Blob, Uint8Array, and ArrayBuffer binary payloads, round-trips exact bytes via getBytes, and returns UploadResult metadata matching fullPath, name, size, and bucket.',
  async observe() {
    return withStorageProbeSession(async ({ storageBucket, objectRef, storageSdk, scrubRunPath }) => {
      return observeUploadBytesPayloadTypes({
        expectedBucket: storageBucket,
        scrubRunPath,
        async uploadAndReadBack(subpath, data) {
          const targetRef = objectRef(subpath);
          const result = await storageSdk.uploadBytes(targetRef, data);
          const downloaded = await storageSdk.getBytes(targetRef);
          return {
            expectedFullPath: targetRef.fullPath,
            expectedName: targetRef.name,
            observed: {
              resultRefFullPath: result.ref.fullPath,
              metadataFullPath: result.metadata.fullPath,
              metadataName: result.metadata.name,
              metadataBucket: result.metadata.bucket,
              metadataSize: result.metadata.size,
              readBytes: Array.from(new Uint8Array(downloaded)),
            },
          };
        },
      });
    });
  },
};
