import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface ContentTypeObservation {
  uploadContentType: string | null;
  storedContentType: string | null;
  size: number;
  readBytes: number[];
}

export interface StorageUploadContentTypeSubject {
  uploadAndInspect(
    subpath: string,
    data: Blob | Uint8Array,
    metadata?: { contentType?: string },
  ): Promise<ContentTypeObservation>;
}

export async function observeUploadBytesContentTypePrecedence(
  subject: StorageUploadContentTypeSubject,
): Promise<Record<string, unknown>> {
  const sampleBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

  const emptyBlobNoHint = await subject.uploadAndInspect(
    'uploadbytes-contenttype/empty-blob-no-hint.bin',
    new Blob([sampleBytes]),
  );
  const typedBlobNoHint = await subject.uploadAndInspect(
    'uploadbytes-contenttype/typed-blob-no-hint.png',
    new Blob([sampleBytes], { type: 'image/png' }),
  );
  const typedBlobCallerOverride = await subject.uploadAndInspect(
    'uploadbytes-contenttype/typed-blob-caller-override.pdf',
    new Blob([sampleBytes], { type: 'image/png' }),
    { contentType: 'application/pdf' },
  );
  const emptyBlobCallerHint = await subject.uploadAndInspect(
    'uploadbytes-contenttype/empty-blob-caller-hint.wav',
    new Blob([sampleBytes]),
    { contentType: 'audio/wav' },
  );
  const uint8NoHint = await subject.uploadAndInspect(
    'uploadbytes-contenttype/uint8-no-hint.bin',
    new Uint8Array(sampleBytes),
  );

  return {
    expectedBytes: Array.from(sampleBytes),
    emptyBlobNoHint,
    typedBlobNoHint,
    typedBlobCallerOverride,
    emptyBlobCallerHint,
    uint8NoHint,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'storage#27',
  rowIds: ['storage#27', 'storage#28', 'storage#30'],
  description:
    'uploadBytes contentType precedence and Blob rewrap: caller metadata.contentType overrides Blob.type, non-empty Blob.type wins when caller omits contentType, and empty Blob.type or raw Uint8Array defaults to application/octet-stream while preserving exact bytes.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      return observeUploadBytesContentTypePrecedence({
        async uploadAndInspect(subpath, data, metadata) {
          const targetRef = objectRef(subpath);
          const uploadResult = await storageSdk.uploadBytes(targetRef, data, metadata);
          const fetchedMeta = await storageSdk.getMetadata(targetRef);
          const downloaded = await storageSdk.getBytes(targetRef);
          return {
            uploadContentType: uploadResult.metadata.contentType ?? null,
            storedContentType: fetchedMeta.contentType ?? null,
            size: uploadResult.metadata.size,
            readBytes: Array.from(new Uint8Array(downloaded)),
          };
        },
      });
    });
  },
};
