import type { FirebaseOptions } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount } from '../../src/oracle-credential.ts';
import { resolveProbeWebConfig } from '../../src/sdk-probe-runtime.ts';
import {
  extractObservedErrorDetails,
  resolveProbeStorageBucket,
  withStorageProbeSession,
} from '../../src/storage-probe-session.ts';

interface DeniedStorageOpOutcome {
  threw: boolean;
  code: string | null;
  errorName: string | null;
  isFirebaseError: boolean;
}

export interface StorageDeniedMetadataAndDeleteSubject {
  seedProtectedObject(): Promise<void>;
  getMetadataOutsideGrant(): Promise<DeniedStorageOpOutcome>;
  updateMetadataOutsideGrant(): Promise<DeniedStorageOpOutcome>;
  deleteObjectOutsideGrant(): Promise<DeniedStorageOpOutcome>;
  getMetadataSignedOutExisting(): Promise<DeniedStorageOpOutcome>;
  updateMetadataSignedOutExisting(): Promise<DeniedStorageOpOutcome>;
  deleteObjectSignedOutExisting(): Promise<DeniedStorageOpOutcome>;
  readProtectedMetadataAfterDenials(): Promise<{
    size: number;
    customMetadata: Record<string, string> | null;
  }>;
}

async function captureDeniedStorageOp(
  runOp: () => Promise<unknown>,
): Promise<DeniedStorageOpOutcome> {
  try {
    await runOp();
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

export async function observeStorageRulesDeniedMetadataAndDelete(
  subject: StorageDeniedMetadataAndDeleteSubject,
): Promise<Record<string, unknown>> {
  await subject.seedProtectedObject();

  const getMetadataOutsideGrant = await subject.getMetadataOutsideGrant();
  const updateMetadataOutsideGrant = await subject.updateMetadataOutsideGrant();
  const deleteObjectOutsideGrant = await subject.deleteObjectOutsideGrant();

  const getMetadataSignedOutExisting = await subject.getMetadataSignedOutExisting();
  const updateMetadataSignedOutExisting = await subject.updateMetadataSignedOutExisting();
  const deleteObjectSignedOutExisting = await subject.deleteObjectSignedOutExisting();

  const existingPreservedAfterDenials = await subject.readProtectedMetadataAfterDenials();

  return {
    getMetadataOutsideGrant,
    updateMetadataOutsideGrant,
    deleteObjectOutsideGrant,
    getMetadataSignedOutExisting,
    updateMetadataSignedOutExisting,
    deleteObjectSignedOutExisting,
    existingPreservedAfterDenials,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'storage#106, #107, #108',
  rowIds: ['storage#106', 'storage#107', 'storage#108'],
  description:
    'firebase/storage op-level security-rules denials: observes getMetadata, updateMetadata, and deleteObject rejecting with FirebaseError storage/unauthorized both outside any grant and from a signed-out client against an existing object.',
  async observe() {
    const sa = await loadOracleServiceAccount();
    const webConfig = await resolveProbeWebConfig(sa);
    const resolvedBucket = resolveProbeStorageBucket(webConfig);
    const [{ deleteApp, initializeApp }, { getAuth }] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
    ]);

    return withStorageProbeSession(async ({ runId, storage, objectPath, objectRef, storageSdk }) => {
      const protectedSubpath = 'denied-ops/protected.txt';
      const protectedFullPath = objectPath(protectedSubpath);
      const outsideGrantFullPath = `pyric_oracle_denied_ops/${runId}/forbidden.txt`;
      const outsideGrantRef = storageSdk.ref(storage, outsideGrantFullPath);

      const signedOutOptions: FirebaseOptions = {
        ...(webConfig as FirebaseOptions),
        storageBucket: resolvedBucket,
      };
      const signedOutApp = initializeApp(
        signedOutOptions,
        `sdk-probe-denied-ops-signed-out-${runId}`,
      );

      try {
        const signedOutAuth = getAuth(signedOutApp);
        if (signedOutAuth.currentUser !== null) {
          throw new Error('expected fresh secondary app to start signed out');
        }
        const signedOutStorage = storageSdk.getStorage(signedOutApp);
        const signedOutExistingRef = storageSdk.ref(signedOutStorage, protectedFullPath);

        return await observeStorageRulesDeniedMetadataAndDelete({
          async seedProtectedObject() {
            await storageSdk.uploadBytes(
              objectRef(protectedSubpath),
              new Uint8Array([104, 101, 108, 108, 111]),
              {
                contentType: 'text/plain',
                customMetadata: { stage: 'initial' },
              },
            );
          },
          async getMetadataOutsideGrant() {
            return captureDeniedStorageOp(() => storageSdk.getMetadata(outsideGrantRef));
          },
          async updateMetadataOutsideGrant() {
            return captureDeniedStorageOp(() =>
              storageSdk.updateMetadata(outsideGrantRef, { customMetadata: { stage: 'mutated' } }),
            );
          },
          async deleteObjectOutsideGrant() {
            return captureDeniedStorageOp(() => storageSdk.deleteObject(outsideGrantRef));
          },
          async getMetadataSignedOutExisting() {
            return captureDeniedStorageOp(() => storageSdk.getMetadata(signedOutExistingRef));
          },
          async updateMetadataSignedOutExisting() {
            return captureDeniedStorageOp(() =>
              storageSdk.updateMetadata(signedOutExistingRef, {
                customMetadata: { stage: 'mutated' },
              }),
            );
          },
          async deleteObjectSignedOutExisting() {
            return captureDeniedStorageOp(() => storageSdk.deleteObject(signedOutExistingRef));
          },
          async readProtectedMetadataAfterDenials() {
            const meta = await storageSdk.getMetadata(objectRef(protectedSubpath));
            let customMetadata: Record<string, string> | null = null;
            if (meta.customMetadata !== undefined) {
              customMetadata = meta.customMetadata;
            }
            return {
              size: meta.size,
              customMetadata,
            };
          },
        });
      } finally {
        await deleteApp(signedOutApp).catch(() => undefined);
      }
    });
  },
};
