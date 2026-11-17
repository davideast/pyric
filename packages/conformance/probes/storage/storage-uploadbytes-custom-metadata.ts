import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface CustomMetadataCaseObservation {
  uploadHasCustomMetadataProperty: boolean;
  uploadCustomMetadata: Record<string, string> | null;
  getMetadataCustomMetadata: Record<string, string> | null;
}

export interface StorageUploadCustomMetadataSubject {
  uploadAndReadCustomMetadata(
    subpath: string,
    customMetadata?: Record<string, string>,
  ): Promise<CustomMetadataCaseObservation>;
}

export async function observeUploadBytesCustomMetadata(
  subject: StorageUploadCustomMetadataSubject,
): Promise<Record<string, unknown>> {
  const withoutCustom = await subject.uploadAndReadCustomMetadata(
    'uploadbytes-custom-metadata/no-custom.bin',
  );
  const withCustom = await subject.uploadAndReadCustomMetadata(
    'uploadbytes-custom-metadata/with-custom.bin',
    {
      owner: 'user-1',
      label: 'alpha release',
      emptyValue: '',
    },
  );

  return {
    withoutCustomMetadata: withoutCustom,
    withCustomMetadata: withCustom,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'uploadBytes customMetadata round-trip: observes UploadResult.metadata.customMetadata and follow-up getMetadata().customMetadata both when omitted and when populated with multiple string keys.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      return observeUploadBytesCustomMetadata({
        async uploadAndReadCustomMetadata(subpath, customMetadata) {
          const targetRef = objectRef(subpath);
          const payload = new Uint8Array([0x6d, 0x65, 0x74, 0x61]);
          let uploadMetadataArg: { customMetadata: Record<string, string> } | undefined;
          if (customMetadata !== undefined) {
            uploadMetadataArg = { customMetadata };
          }
          const uploaded = await storageSdk.uploadBytes(targetRef, payload, uploadMetadataArg);
          const fetched = await storageSdk.getMetadata(targetRef);

          let uploadCustom: Record<string, string> | null = null;
          if (uploaded.metadata.customMetadata !== undefined) {
            uploadCustom = uploaded.metadata.customMetadata;
          }
          let fetchedCustom: Record<string, string> | null = null;
          if (fetched.customMetadata !== undefined) {
            fetchedCustom = fetched.customMetadata;
          }

          return {
            uploadHasCustomMetadataProperty: uploaded.metadata.customMetadata !== undefined,
            uploadCustomMetadata: uploadCustom,
            getMetadataCustomMetadata: fetchedCustom,
          };
        },
      });
    });
  },
};
