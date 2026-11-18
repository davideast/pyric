import type { Probe } from '../../rigs/types.ts';
import {
  extractObservedErrorDetails,
  withStorageProbeSession,
} from '../../src/storage-probe-session.ts';

export interface MissingMetadataAttempt {
  threw: boolean;
  code: string | null;
  errorName: string | null;
  isFirebaseError: boolean;
}

export interface StorageMissingMetadataSubject {
  attemptGetMissing(subpath: string): Promise<MissingMetadataAttempt>;
  attemptUpdateMissing(subpath: string): Promise<MissingMetadataAttempt>;
}

export async function captureMissingMetadataCall(
  work: () => Promise<unknown>,
): Promise<MissingMetadataAttempt> {
  try {
    await work();
    return {
      threw: false,
      code: null,
      errorName: null,
      isFirebaseError: false,
    };
  } catch (err) {
    const details = extractObservedErrorDetails(err);
    return {
      threw: true,
      code: details.code,
      errorName: details.errorName,
      isFirebaseError: details.isFirebaseError,
    };
  }
}

export async function observeMetadataMissingObjectErrors(
  subject: StorageMissingMetadataSubject,
): Promise<Record<string, unknown>> {
  const getMetadataMissing = await subject.attemptGetMissing('metadata-missing/nonexistent.bin');
  const updateMetadataMissing = await subject.attemptUpdateMissing(
    'metadata-missing/nonexistent.bin',
  );
  return {
    getMetadataMissing,
    updateMetadataMissing,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'getMetadata(ref) and updateMetadata(ref, patch) on a missing object path: observes FirebaseError storage/object-not-found on both operations.',
  async observe() {
    return withStorageProbeSession(async ({ storage, objectPath, storageSdk }) => {
      return observeMetadataMissingObjectErrors({
        async attemptGetMissing(subpath) {
          const missingRef = storageSdk.ref(storage, objectPath(subpath));
          return captureMissingMetadataCall(() => storageSdk.getMetadata(missingRef));
        },
        async attemptUpdateMissing(subpath) {
          const missingRef = storageSdk.ref(storage, objectPath(subpath));
          return captureMissingMetadataCall(() =>
            storageSdk.updateMetadata(missingRef, { contentType: 'text/plain' }),
          );
        },
      });
    });
  },
};
