import type { Probe } from '../../rigs/types.ts';
import { extractObservedErrorDetails, withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface CanonicalNamespaceOrdinaryOutcome {
  refFullPath: string;
  uploadMetadataFullPath: string;
  fetchedMetadataFullPath: string;
  fetchedMetadataName: string;
  startsWithCanonicalBucketPrefix: boolean;
  metadataMatchesRefFullPath: boolean;
}

interface CanonicalNamespacePrefixedOutcome {
  normalizedRefStartsWithB: boolean;
  uploadThrew: boolean;
  uploadCode: string | null;
  uploadIsFirebaseError: boolean;
}

export interface StorageCanonicalNamespaceSubject {
  uploadAndReadOrdinaryPath(): Promise<CanonicalNamespaceOrdinaryOutcome>;
  attemptUploadWithCanonicalRulesPrefix(): Promise<CanonicalNamespacePrefixedOutcome>;
}

export async function observeStorageCanonicalBucketNamespace(
  subject: StorageCanonicalNamespaceSubject,
): Promise<Record<string, unknown>> {
  const ordinaryObjectPath = await subject.uploadAndReadOrdinaryPath();
  const explicitRulesPrefixPath = await subject.attemptUploadWithCanonicalRulesPrefix();

  return {
    ordinaryObjectPath,
    explicitRulesPrefixPath,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'storage#109',
  rowIds: ['storage#109'],
  description:
    'firebase/storage canonical /b/{bucket}/o/{object} rules namespace mapping: observes ordinary SDK object paths matching /b/{bucket}/o/... rules while preserving ordinary fullPath in StorageReference and FullMetadata, whereas pre-prefixed /b/<bucket>/o/... SDK paths evaluate outside the object grant.',
  async observe() {
    return withStorageProbeSession(
      async ({ storage, storageBucket, objectPath, objectRef, scrubRunPath, storageSdk }) => {
        const subpath = 'namespace-mapping/item.txt';
        const payload = new Uint8Array([111, 107]);

        return observeStorageCanonicalBucketNamespace({
          async uploadAndReadOrdinaryPath() {
            const targetRef = objectRef(subpath);
            const uploadRes = await storageSdk.uploadBytes(targetRef, payload, {
              contentType: 'text/plain',
            });
            const fetched = await storageSdk.getMetadata(targetRef);
            const refFullPath = scrubRunPath(targetRef.fullPath);
            const uploadMetadataFullPath = scrubRunPath(uploadRes.metadata.fullPath);
            const fetchedMetadataFullPath = scrubRunPath(fetched.fullPath);

            return {
              refFullPath,
              uploadMetadataFullPath,
              fetchedMetadataFullPath,
              fetchedMetadataName: fetched.name,
              startsWithCanonicalBucketPrefix: fetchedMetadataFullPath.startsWith('b/'),
              metadataMatchesRefFullPath: fetchedMetadataFullPath === refFullPath,
            };
          },
          async attemptUploadWithCanonicalRulesPrefix() {
            const rawAllowedPath = objectPath(subpath);
            const prePrefixedRef = storageSdk.ref(
              storage,
              `/b/${storageBucket}/o/${rawAllowedPath}`,
            );
            const normalizedRefStartsWithB = prePrefixedRef.fullPath.startsWith(
              `b/${storageBucket}/o/`,
            );
            try {
              await storageSdk.uploadBytes(prePrefixedRef, payload);
              return {
                normalizedRefStartsWithB,
                uploadThrew: false,
                uploadCode: null,
                uploadIsFirebaseError: false,
              };
            } catch (err) {
              const details = extractObservedErrorDetails(err);
              return {
                normalizedRefStartsWithB,
                uploadThrew: true,
                uploadCode: details.code,
                uploadIsFirebaseError: details.isFirebaseError,
              };
            }
          },
        });
      },
    );
  },
};
