import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface ObservedObjectMetadataSnapshot {
  size: number;
  contentType: string | null;
  customMetadata: Record<string, string> | null;
  generation: string;
  metageneration: string;
}

export interface StorageDeleteMetadataSubject {
  uploadObject(
    bytes: Uint8Array,
    metadata: { contentType: string; customMetadata: Record<string, string> },
  ): Promise<void>;
  readMetadata(): Promise<ObservedObjectMetadataSnapshot>;
  removeObject(): Promise<void>;
  scrubRunPath(text: string): string;
}

export async function observeDeleteThenGetMetadata(
  subject: StorageDeleteMetadataSubject,
): Promise<Record<string, unknown>> {
  const payload = new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]);
  await subject.uploadObject(payload, {
    contentType: 'application/octet-stream',
    customMetadata: { stage: 'before-delete' },
  });

  const preDelete = await subject.readMetadata();
  await subject.removeObject();

  let postDeleteOutcome: Record<string, unknown>;
  try {
    const surviving = await subject.readMetadata();
    postDeleteOutcome = {
      threw: false,
      code: null,
      errorName: null,
      isFirebaseError: false,
      message: null,
      survivingGeneration: surviving.generation,
    };
  } catch (err) {
    let code: string | null = null;
    let errorName: string | null = null;
    let rawMessage: string | null = null;
    if (err !== null && typeof err === 'object') {
      const candidate = err as { code?: unknown; name?: unknown; message?: unknown };
      if (typeof candidate.code === 'string') {
        code = candidate.code;
      }
      if (typeof candidate.name === 'string') {
        errorName = candidate.name;
      }
      if (typeof candidate.message === 'string') {
        rawMessage = candidate.message;
      }
    } else {
      rawMessage = String(err);
    }
    let scrubbedMessage: string | null = null;
    if (rawMessage !== null) {
      scrubbedMessage = subject.scrubRunPath(rawMessage);
    }
    postDeleteOutcome = {
      threw: true,
      code,
      errorName,
      isFirebaseError: errorName === 'FirebaseError',
      message: scrubbedMessage,
    };
  }

  return {
    beforeDelete: {
      size: preDelete.size,
      contentType: preDelete.contentType,
      customMetadata: preDelete.customMetadata,
      hasGeneration: preDelete.generation.length > 0,
      metageneration: preDelete.metageneration,
    },
    deleteCompleted: true,
    afterDeleteGetMetadata: postDeleteOutcome,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'uploadBytes with customMetadata, verify getMetadata reads the stored metadata, call deleteObject, then call getMetadata on the deleted reference and observe the error shape.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk, scrubRunPath }) => {
      const targetRef = objectRef('delete-then-getmetadata/ephemeral.bin');
      return observeDeleteThenGetMetadata({
        async uploadObject(bytes, metadata) {
          await storageSdk.uploadBytes(targetRef, bytes, metadata);
        },
        async readMetadata() {
          const md = await storageSdk.getMetadata(targetRef);
          return {
            size: md.size,
            contentType: md.contentType ?? null,
            customMetadata: md.customMetadata ?? null,
            generation: md.generation,
            metageneration: md.metageneration,
          };
        },
        async removeObject() {
          await storageSdk.deleteObject(targetRef);
        },
        scrubRunPath,
      });
    });
  },
};
