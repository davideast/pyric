import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface UploadStepMetadataSnapshot {
  size: number;
  contentType: string | null;
  customMetadata: Record<string, string> | null;
  generation: string;
  metageneration: string;
}

export interface StorageUploadOverwriteSubject {
  uploadVersion(
    bytes: Uint8Array,
    metadata: { contentType: string; customMetadata: Record<string, string> },
  ): Promise<UploadStepMetadataSnapshot>;
  readCurrentBytes(): Promise<number[]>;
  readCurrentMetadata(): Promise<UploadStepMetadataSnapshot>;
}

function isDecimalDigitString(value: string): boolean {
  return typeof value === 'string' && /^\d+$/.test(value);
}

export async function observeUploadBytesOverwriteGenerations(
  subject: StorageUploadOverwriteSubject,
): Promise<Record<string, unknown>> {
  const firstBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  const secondBytes = new Uint8Array([10, 20, 30]);

  const first = await subject.uploadVersion(firstBytes, {
    contentType: 'application/octet-stream',
    customMetadata: { revision: 'first', extra: 'removed-on-overwrite' },
  });
  const second = await subject.uploadVersion(secondBytes, {
    contentType: 'application/json',
    customMetadata: { revision: 'second' },
  });

  const storedBytes = await subject.readCurrentBytes();
  const storedMeta = await subject.readCurrentMetadata();

  const firstIsDigits = isDecimalDigitString(first.generation);
  const secondIsDigits = isDecimalDigitString(second.generation);
  let generationStrictlyIncreased = false;
  if (firstIsDigits && secondIsDigits) {
    generationStrictlyIncreased = BigInt(second.generation) > BigInt(first.generation);
  }

  return {
    firstUpload: {
      size: first.size,
      contentType: first.contentType,
      customMetadata: first.customMetadata,
      generationType: typeof first.generation,
      generationIsDecimalDigits: firstIsDigits,
      metagenerationType: typeof first.metageneration,
      metageneration: first.metageneration,
    },
    secondUpload: {
      size: second.size,
      contentType: second.contentType,
      customMetadata: second.customMetadata,
      generationType: typeof second.generation,
      generationIsDecimalDigits: secondIsDigits,
      metagenerationType: typeof second.metageneration,
      metageneration: second.metageneration,
    },
    generationChanged: second.generation !== first.generation,
    generationStrictlyIncreased,
    afterOverwriteReadBytes: storedBytes,
    afterOverwriteGetMetadata: {
      size: storedMeta.size,
      contentType: storedMeta.contentType,
      customMetadata: storedMeta.customMetadata,
      generationMatchesSecondUpload: storedMeta.generation === second.generation,
      metageneration: storedMeta.metageneration,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'storage#35',
  rowIds: ['storage#35', 'storage#38', 'storage#118'],
  description:
    'uploadBytes overwrite and generation semantics: uploading twice to the same path replaces bytes and metadata instead of appending, issues a strictly larger numeric string generation, and resets metageneration to "1" on each fresh version.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      const targetRef = objectRef('uploadbytes-overwrite/versioned.bin');
      return observeUploadBytesOverwriteGenerations({
        async uploadVersion(bytes, metadata) {
          const uploaded = await storageSdk.uploadBytes(targetRef, bytes, metadata);
          return {
            size: uploaded.metadata.size,
            contentType: uploaded.metadata.contentType ?? null,
            customMetadata: uploaded.metadata.customMetadata ?? null,
            generation: uploaded.metadata.generation,
            metageneration: uploaded.metadata.metageneration,
          };
        },
        async readCurrentBytes() {
          const buf = await storageSdk.getBytes(targetRef);
          return Array.from(new Uint8Array(buf));
        },
        async readCurrentMetadata() {
          const md = await storageSdk.getMetadata(targetRef);
          return {
            size: md.size,
            contentType: md.contentType ?? null,
            customMetadata: md.customMetadata ?? null,
            generation: md.generation,
            metageneration: md.metageneration,
          };
        },
      });
    });
  },
};
