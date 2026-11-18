import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface SettableFieldsSnapshot {
  size: number;
  contentType: string | null;
  cacheControl: string | null;
  contentDisposition: string | null;
  contentEncoding: string | null;
  contentLanguage: string | null;
  customMetadata: Record<string, string> | null;
}

export interface StorageUpdateMetadataFieldsSubject {
  uploadUpdateAndReadBack(subpath: string): Promise<{
    initialBytes: number[];
    beforeUpdate: SettableFieldsSnapshot;
    updateReturn: SettableFieldsSnapshot;
    afterGetMetadata: SettableFieldsSnapshot;
    afterReadBytes: number[];
  }>;
}

export async function observeUpdateMetadataFieldsAndBytes(
  subject: StorageUpdateMetadataFieldsSubject,
): Promise<Record<string, unknown>> {
  const observed = await subject.uploadUpdateAndReadBack(
    'updatemetadata-fields/item.bin',
  );
  return {
    initialBytes: observed.initialBytes,
    beforeUpdate: observed.beforeUpdate,
    updateReturn: observed.updateReturn,
    afterGetMetadata: observed.afterGetMetadata,
    afterReadBytes: observed.afterReadBytes,
  };
}

function nullableField(value: string | undefined): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

function toSettableSnapshot(md: {
  size: number;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  customMetadata?: Record<string, string>;
}): SettableFieldsSnapshot {
  let customMetadata: Record<string, string> | null = null;
  if (md.customMetadata !== undefined) {
    customMetadata = md.customMetadata;
  }
  return {
    size: md.size,
    contentType: nullableField(md.contentType),
    cacheControl: nullableField(md.cacheControl),
    contentDisposition: nullableField(md.contentDisposition),
    contentEncoding: nullableField(md.contentEncoding),
    contentLanguage: nullableField(md.contentLanguage),
    customMetadata,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'storage / updateMetadata(ref, metadata) / #82, #85',
  rowIds: ['storage#82', 'storage#85'],
  description:
    'updateMetadata(ref, patch) settable-field updates, RFC 7396 customMetadata merge, and byte preservation: observes contentType, cacheControl, contentDisposition, contentEncoding, contentLanguage, and customMetadata alongside unchanged object bytes.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      return observeUpdateMetadataFieldsAndBytes({
        async uploadUpdateAndReadBack(subpath) {
          const targetRef = objectRef(subpath);
          const rawBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x21]);
          const uploaded = await storageSdk.uploadBytes(targetRef, rawBytes, {
            contentType: 'text/plain',
            cacheControl: 'no-cache',
            contentDisposition: 'inline',
            contentEncoding: 'identity',
            contentLanguage: 'en',
            customMetadata: {
              k1: 'v1',
              k2: 'v2',
            },
          });

          const updated = await storageSdk.updateMetadata(targetRef, {
            contentType: 'application/octet-stream',
            cacheControl: 'public, max-age=60',
            contentDisposition: 'attachment; filename="item.bin"',
            contentEncoding: 'identity',
            contentLanguage: 'fr',
            customMetadata: {
              k2: 'v2-next',
              k3: 'v3',
            },
          });

          const refetched = await storageSdk.getMetadata(targetRef);
          const downloaded = await storageSdk.getBytes(targetRef);

          return {
            initialBytes: Array.from(rawBytes),
            beforeUpdate: toSettableSnapshot(uploaded.metadata),
            updateReturn: toSettableSnapshot(updated),
            afterGetMetadata: toSettableSnapshot(refetched),
            afterReadBytes: Array.from(new Uint8Array(downloaded)),
          };
        },
      });
    });
  },
};
