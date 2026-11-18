import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface DataUrlUploadObservation {
  size: number;
  uploadedContentType: string | null;
  fetchedContentType: string | null;
  decodedBytes: number[];
  decodedUtf8: string;
}

export interface StorageUploadStringDataUrlSubject {
  uploadDataUrlAndRead(
    subpath: string,
    dataUrl: string,
    metadata?: { contentType?: string },
  ): Promise<DataUrlUploadObservation>;
}

export async function observeStorageUploadStringDataUrlVariants(
  subject: StorageUploadStringDataUrlSubject,
): Promise<Record<string, unknown>> {
  const base64JsonDataUrl = await subject.uploadDataUrlAndRead(
    'uploadstring-dataurl/doc.json',
    'data:application/json;base64,eyJvayI6dHJ1ZX0=',
  );
  const percentEncodedDataUrl = await subject.uploadDataUrlAndRead(
    'uploadstring-dataurl/note.txt',
    'data:text/plain,hello%20world%21',
  );
  const callerContentTypeOverride = await subject.uploadDataUrlAndRead(
    'uploadstring-dataurl/override.csv',
    'data:text/plain;base64,YSwx',
    { contentType: 'text/csv' },
  );

  return {
    base64JsonDataUrl,
    percentEncodedDataUrl,
    callerContentTypeOverride,
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
    'firebase/storage uploadString(ref, value, "data_url", metadata?): observes MIME inference and base64 decoding, percent-decoded non-base64 bodies, and caller metadata.contentType precedence.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      return observeStorageUploadStringDataUrlVariants({
        async uploadDataUrlAndRead(subpath, dataUrl, metadata) {
          const targetRef = objectRef(subpath);
          let uploaded;
          if (metadata === undefined) {
            uploaded = await storageSdk.uploadString(targetRef, dataUrl, 'data_url');
          } else {
            uploaded = await storageSdk.uploadString(targetRef, dataUrl, 'data_url', metadata);
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
