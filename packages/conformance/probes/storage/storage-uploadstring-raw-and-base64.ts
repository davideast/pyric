import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface UploadedStringObservation {
  size: number;
  uploadedContentType: string | null;
  fetchedContentType: string | null;
  decodedBytes: number[];
  decodedUtf8: string;
}

export interface StorageUploadStringRawAndBase64Subject {
  uploadAndRead(
    subpath: string,
    value: string,
    format?: 'raw' | 'base64',
  ): Promise<UploadedStringObservation>;
}

export async function observeStorageUploadStringRawAndBase64(
  subject: StorageUploadStringRawAndBase64Subject,
): Promise<Record<string, unknown>> {
  const defaultRaw = await subject.uploadAndRead('uploadstring/default-raw.txt', 'Hello, UTF-8!');
  const explicitRaw = await subject.uploadAndRead(
    'uploadstring/explicit-raw.txt',
    'Explicit raw line',
    'raw',
  );
  const standardBase64 = await subject.uploadAndRead(
    'uploadstring/standard-b64.bin',
    'AQID/w==',
    'base64',
  );

  return {
    defaultRaw,
    explicitRaw,
    standardBase64,
  };
}

function nullableContentType(value: string | undefined): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase/storage uploadString(ref, value, format?): observes default and explicit format="raw" UTF-8 encoding and default contentType alongside format="base64" binary decoding.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      return observeStorageUploadStringRawAndBase64({
        async uploadAndRead(subpath, value, format) {
          const targetRef = objectRef(subpath);
          let uploaded;
          if (format === undefined) {
            uploaded = await storageSdk.uploadString(targetRef, value);
          } else {
            uploaded = await storageSdk.uploadString(targetRef, value, format);
          }
          const fetched = await storageSdk.getMetadata(targetRef);
          const buf = await storageSdk.getBytes(targetRef);
          const bytes = new Uint8Array(buf);
          return {
            size: uploaded.metadata.size,
            uploadedContentType: nullableContentType(uploaded.metadata.contentType),
            fetchedContentType: nullableContentType(fetched.contentType),
            decodedBytes: [...bytes],
            decodedUtf8: decoder.decode(bytes),
          };
        },
      });
    });
  },
};
