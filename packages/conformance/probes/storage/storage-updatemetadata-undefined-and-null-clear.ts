import type { FullMetadata, SettableMetadata } from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

export interface ProjectedWritableMetadata {
  contentType: string | null;
  cacheControl: string | null;
  contentDisposition: string | null;
  contentLanguage: string | null;
  customMetadata: Record<string, string> | null;
}

function projectWritableMetadata(meta: FullMetadata): ProjectedWritableMetadata {
  let contentType: string | null = null;
  if (meta.contentType !== undefined) {
    contentType = meta.contentType;
  }
  let cacheControl: string | null = null;
  if (meta.cacheControl !== undefined) {
    cacheControl = meta.cacheControl;
  }
  let contentDisposition: string | null = null;
  if (meta.contentDisposition !== undefined) {
    contentDisposition = meta.contentDisposition;
  }
  let contentLanguage: string | null = null;
  if (meta.contentLanguage !== undefined) {
    contentLanguage = meta.contentLanguage;
  }
  let customMetadata: Record<string, string> | null = null;
  if (meta.customMetadata !== undefined) {
    customMetadata = meta.customMetadata;
  }
  return {
    contentType,
    cacheControl,
    contentDisposition,
    contentLanguage,
    customMetadata,
  };
}

export interface UpdateMetadataUndefinedNullSubject {
  seedWithAllWritableFields(subpath: string): Promise<ProjectedWritableMetadata>;
  patchMetadata(subpath: string, patch: Record<string, unknown>): Promise<ProjectedWritableMetadata>;
  readMetadata(subpath: string): Promise<ProjectedWritableMetadata>;
}

export async function observeUpdateMetadataUndefinedAndNullClear(
  subject: UpdateMetadataUndefinedNullSubject,
): Promise<Record<string, unknown>> {
  const subpath = 'updatemetadata-undefined-null/item.txt';
  const seeded = await subject.seedWithAllWritableFields(subpath);

  const afterUndefinedFields = await subject.patchMetadata(subpath, {
    cacheControl: undefined,
    contentDisposition: undefined,
    contentLanguage: 'fr',
    customMetadata: undefined,
  });
  const readAfterUndefined = await subject.readMetadata(subpath);

  const afterNullScalarAndKeyClear = await subject.patchMetadata(subpath, {
    cacheControl: null,
    contentDisposition: null,
    customMetadata: { keep: 'yes', drop: null },
  });
  const readAfterNullScalarAndKeyClear = await subject.readMetadata(subpath);

  const afterNullCustomMetadataMap = await subject.patchMetadata(subpath, {
    customMetadata: null,
  });
  const readAfterNullCustomMetadataMap = await subject.readMetadata(subpath);

  return {
    seeded,
    afterUndefinedFields,
    readAfterUndefined,
    afterNullScalarAndKeyClear,
    readAfterNullScalarAndKeyClear,
    afterNullCustomMetadataMap,
    readAfterNullCustomMetadataMap,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'storage #86',
  rowIds: ['storage#86'],
  description:
    'firebase/storage updateMetadata(ref, patch): observes undefined field values preserving prior stored metadata vs null clearing writable scalar fields and customMetadata entries/maps.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      return observeUpdateMetadataUndefinedAndNullClear({
        async seedWithAllWritableFields(subpath) {
          const res = await storageSdk.uploadBytes(
            objectRef(subpath),
            new Uint8Array([104, 105]),
            {
              contentType: 'text/plain',
              cacheControl: 'public, max-age=60',
              contentDisposition: 'inline',
              contentLanguage: 'en',
              customMetadata: { keep: 'yes', drop: 'soon' },
            },
          );
          return projectWritableMetadata(res.metadata);
        },
        async patchMetadata(subpath, patch) {
          const updated = await storageSdk.updateMetadata(
            objectRef(subpath),
            patch as unknown as SettableMetadata,
          );
          return projectWritableMetadata(updated);
        },
        async readMetadata(subpath) {
          const fetched = await storageSdk.getMetadata(objectRef(subpath));
          return projectWritableMetadata(fetched);
        },
      });
    });
  },
};
