import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface FullMetadataSnapshot {
  name: string;
  scrubbedFullPath: string;
  size: number;
  metageneration: string;
  contentType: string | null;
  cacheControl: string | null;
  contentDisposition: string | null;
  contentEncoding: string | null;
  contentLanguage: string | null;
  customMetadata: Record<string, string> | null;
  bucketMatchesHandle: boolean;
  generationIsDigits: boolean;
  generationMatchesUpload: boolean;
  timeCreatedMatchesUpload: boolean;
  updatedMatchesUpload: boolean;
}

export interface StorageGetMetadataShapeSubject {
  uploadAndFetchFullShape(subpath: string): Promise<{
    uploadedShape: Omit<
      FullMetadataSnapshot,
      'generationMatchesUpload' | 'timeCreatedMatchesUpload' | 'updatedMatchesUpload'
    >;
    fetchedShape: FullMetadataSnapshot;
  }>;
}

export async function observeGetMetadataFullShape(
  subject: StorageGetMetadataShapeSubject,
): Promise<Record<string, unknown>> {
  const { uploadedShape, fetchedShape } = await subject.uploadAndFetchFullShape(
    'metadata-full-shape/doc.json',
  );
  return {
    uploadedShape,
    fetchedShape,
  };
}

function nullableString(value: string | undefined): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

function nullableCustomMetadata(
  value: Record<string, string> | undefined,
): Record<string, string> | null {
  if (value !== undefined) {
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
    'getMetadata(ref) after uploadBytes with full SettableMetadata: observes field-by-field FullMetadata parity against UploadResult.metadata.',
  async observe() {
    return withStorageProbeSession(
      async ({ objectRef, storageBucket, storageSdk, scrubRunPath }) => {
        return observeGetMetadataFullShape({
          async uploadAndFetchFullShape(subpath) {
            const targetRef = objectRef(subpath);
            const payload = new Uint8Array([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x31, 0x7d]);
            const uploaded = await storageSdk.uploadBytes(targetRef, payload, {
              contentType: 'application/json',
              cacheControl: 'public, max-age=300',
              contentDisposition: 'inline; filename="doc.json"',
              contentEncoding: 'identity',
              contentLanguage: 'en',
              customMetadata: {
                owner: 'user-1',
                tier: 'standard',
              },
            });
            const fetched = await storageSdk.getMetadata(targetRef);
            const up = uploaded.metadata;

            const uploadedShape = {
              name: up.name,
              scrubbedFullPath: scrubRunPath(up.fullPath),
              size: up.size,
              metageneration: up.metageneration,
              contentType: nullableString(up.contentType),
              cacheControl: nullableString(up.cacheControl),
              contentDisposition: nullableString(up.contentDisposition),
              contentEncoding: nullableString(up.contentEncoding),
              contentLanguage: nullableString(up.contentLanguage),
              customMetadata: nullableCustomMetadata(up.customMetadata),
              bucketMatchesHandle: up.bucket === storageBucket,
              generationIsDigits: /^\d+$/.test(up.generation),
            };

            const fetchedShape: FullMetadataSnapshot = {
              name: fetched.name,
              scrubbedFullPath: scrubRunPath(fetched.fullPath),
              size: fetched.size,
              metageneration: fetched.metageneration,
              contentType: nullableString(fetched.contentType),
              cacheControl: nullableString(fetched.cacheControl),
              contentDisposition: nullableString(fetched.contentDisposition),
              contentEncoding: nullableString(fetched.contentEncoding),
              contentLanguage: nullableString(fetched.contentLanguage),
              customMetadata: nullableCustomMetadata(fetched.customMetadata),
              bucketMatchesHandle: fetched.bucket === storageBucket,
              generationIsDigits: /^\d+$/.test(fetched.generation),
              generationMatchesUpload: fetched.generation === up.generation,
              timeCreatedMatchesUpload: fetched.timeCreated === up.timeCreated,
              updatedMatchesUpload: fetched.updated === up.updated,
            };

            return { uploadedShape, fetchedShape };
          },
        });
      },
    );
  },
};
