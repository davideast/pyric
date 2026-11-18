import { describe, expect, it } from 'bun:test';
import { probe as deleteRootProbe } from '../../probes/storage/client-storage-deleteobject-root-ref.ts';
import {
  observeStorageDeleteRemovesBytesAndMetadata,
  probe as deleteAtomicProbe,
  type StorageDeleteAtomicSubject,
} from '../../probes/storage/storage-deleteobject-removes-bytes-and-metadata.ts';
import {
  observeStorageListAllRootRef,
  probe as listAllRootProbe,
  rootListOracleTarget,
  type StorageListAllRootSubject,
} from '../../probes/storage/storage-listall-root-ref.ts';
import {
  observeStorageCanonicalBucketNamespace,
  probe as canonicalNamespaceProbe,
  type StorageCanonicalNamespaceSubject,
} from '../../probes/storage/storage-rules-canonical-bucket-namespace.ts';
import {
  observeStorageRulesDeniedMetadataAndDelete,
  probe as deniedMetadataAndDeleteProbe,
  type StorageDeniedMetadataAndDeleteSubject,
} from '../../probes/storage/storage-rules-denied-metadata-and-delete.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const SDK_PROBES = [
  { name: 'storage-deleteobject-removes-bytes-and-metadata', probe: deleteAtomicProbe },
  { name: 'storage-listall-root-ref', probe: listAllRootProbe },
  { name: 'storage-rules-denied-metadata-and-delete', probe: deniedMetadataAndDeleteProbe },
  { name: 'storage-rules-canonical-bucket-namespace', probe: canonicalNamespaceProbe },
] as const;

const CLIENT_STORAGE_PROBES = [
  { name: 'client-storage-deleteobject-root-ref', probe: deleteRootProbe },
] as const;

describe('storage deleteObject, root listAll, and rules-enforcement staged probes (storage#63, #65, #75, #106..109)', () => {
  it('observeStorageDeleteRemovesBytesAndMetadata records pre-delete reads and post-delete object-not-found', async () => {
    const store = new Map<
      string,
      { bytes: Uint8Array; contentType: string; customMetadata: Record<string, string> }
    >();
    const subject: StorageDeleteAtomicSubject = {
      async seedObject(subpath, bytes, contentType, customMetadata) {
        store.set(subpath, {
          bytes: new Uint8Array(bytes),
          contentType,
          customMetadata: { ...customMetadata },
        });
      },
      async readBytes(subpath) {
        const entry = store.get(subpath);
        if (!entry) {
          return {
            threw: true,
            code: 'storage/object-not-found',
            errorName: 'FirebaseError',
            isFirebaseError: true,
            byteLength: null,
            bytes: null,
          };
        }
        return {
          threw: false,
          code: null,
          errorName: null,
          isFirebaseError: false,
          byteLength: entry.bytes.byteLength,
          bytes: [...entry.bytes],
        };
      },
      async readMetadata(subpath) {
        const entry = store.get(subpath);
        if (!entry) {
          return {
            threw: true,
            code: 'storage/object-not-found',
            errorName: 'FirebaseError',
            isFirebaseError: true,
            size: null,
            contentType: null,
            customMetadata: null,
          };
        }
        return {
          threw: false,
          code: null,
          errorName: null,
          isFirebaseError: false,
          size: entry.bytes.byteLength,
          contentType: entry.contentType,
          customMetadata: entry.customMetadata,
        };
      },
      async deleteTarget(subpath) {
        store.delete(subpath);
        return { resolvedUndefined: true };
      },
    };

    const observed = await observeStorageDeleteRemovesBytesAndMetadata(subject);
    expect(observed.deleteResolvedUndefined).toBe(true);
    expect(observed.beforeDeleteBytes).toMatchObject({ threw: false, byteLength: 4 });
    expect(observed.beforeDeleteMetadata).toMatchObject({
      threw: false,
      customMetadata: { tag: 'ephemeral' },
    });
    expect(observed.afterDeleteBytes).toMatchObject({
      threw: true,
      code: 'storage/object-not-found',
    });
    expect(observed.afterDeleteMetadata).toMatchObject({
      threw: true,
      code: 'storage/object-not-found',
    });
  });

  it('observeStorageListAllRootRef, observeStorageRulesDeniedMetadataAndDelete, and observeStorageCanonicalBucketNamespace record deterministic facts', async () => {
    const rootListSubject: StorageListAllRootSubject = {
      rootItemName: 'pyric_oracle_root_r1.bin',
      rootPrefixName: 'pyric_oracle_root_r1',
      nestedChildFullPath: 'pyric_oracle_root_r1/nested/child.bin',
      async seedAndListRoot() {
        return {
          rootFullPath: '',
          rootName: '',
          rootParentIsNull: true,
          items: [
            {
              fullPath: 'pyric_oracle_root_r1.bin',
              name: 'pyric_oracle_root_r1.bin',
              parentFullPath: '',
            },
          ],
          prefixes: [
            {
              fullPath: 'pyric_oracle_root_r1',
              name: 'pyric_oracle_root_r1',
              parentFullPath: '',
            },
          ],
          nextPageTokenIsUndefined: true,
        };
      },
    };
    const rootObserved = await observeStorageListAllRootRef(rootListSubject);
    expect(rootObserved).toEqual({
      rootFullPath: '',
      rootName: '',
      rootParentIsNull: true,
      containsSeededRootItem: true,
      containsSeededRootPrefix: true,
      nestedChildExcludedFromRootItems: true,
      itemsSortedLexicographically: true,
      prefixesSortedLexicographically: true,
      nextPageTokenIsUndefined: true,
    });
    const rootTarget = rootListOracleTarget('demo-bucket', 'r1', 'uid_1');
    expect(rootTarget.block).toContain('match /{allPaths=**} {\n      allow list:');
    expect(rootTarget.freshRules).toContain('match /{allPaths=**} {\n      allow list:');

    const deniedOutcome = {
      threw: true,
      code: 'storage/unauthorized',
      errorName: 'FirebaseError',
      isFirebaseError: true,
    };
    const deniedSubject: StorageDeniedMetadataAndDeleteSubject = {
      async seedProtectedObject() {},
      async getMetadataOutsideGrant() {
        return deniedOutcome;
      },
      async updateMetadataOutsideGrant() {
        return deniedOutcome;
      },
      async deleteObjectOutsideGrant() {
        return deniedOutcome;
      },
      async getMetadataSignedOutExisting() {
        return deniedOutcome;
      },
      async updateMetadataSignedOutExisting() {
        return deniedOutcome;
      },
      async deleteObjectSignedOutExisting() {
        return deniedOutcome;
      },
      async readProtectedMetadataAfterDenials() {
        return { size: 5, customMetadata: { stage: 'initial' } };
      },
    };
    const deniedObserved = await observeStorageRulesDeniedMetadataAndDelete(deniedSubject);
    expect(deniedObserved.getMetadataOutsideGrant).toMatchObject({
      code: 'storage/unauthorized',
    });
    expect(deniedObserved.updateMetadataSignedOutExisting).toMatchObject({
      code: 'storage/unauthorized',
    });
    expect(deniedObserved.deleteObjectSignedOutExisting).toMatchObject({
      code: 'storage/unauthorized',
    });
    expect(deniedObserved.existingPreservedAfterDenials).toEqual({
      size: 5,
      customMetadata: { stage: 'initial' },
    });

    const namespaceSubject: StorageCanonicalNamespaceSubject = {
      async uploadAndReadOrdinaryPath() {
        return {
          refFullPath: 'pyric_oracle/<runId>/namespace-mapping/item.txt',
          uploadMetadataFullPath: 'pyric_oracle/<runId>/namespace-mapping/item.txt',
          fetchedMetadataFullPath: 'pyric_oracle/<runId>/namespace-mapping/item.txt',
          fetchedMetadataName: 'item.txt',
          startsWithCanonicalBucketPrefix: false,
          metadataMatchesRefFullPath: true,
        };
      },
      async attemptUploadWithCanonicalRulesPrefix() {
        return {
          normalizedRefStartsWithB: true,
          uploadThrew: true,
          uploadCode: 'storage/unauthorized',
          uploadIsFirebaseError: true,
        };
      },
    };
    const namespaceObserved = await observeStorageCanonicalBucketNamespace(namespaceSubject);
    expect(namespaceObserved).toMatchObject({
      ordinaryObjectPath: {
        startsWithCanonicalBucketPrefix: false,
        metadataMatchesRefFullPath: true,
      },
      explicitRulesPrefixPath: {
        normalizedRefStartsWithB: true,
        uploadThrew: true,
        uploadCode: 'storage/unauthorized',
      },
    });
  });

  it('executes client-storage root deleteObject preflight offline and verifies staged registration', async () => {
    const rootObserved = await deleteRootProbe.observe();
    expect(rootObserved).toMatchObject({
      rootFullPath: '',
      rootName: '',
      threw: true,
      threwSynchronously: true,
      code: 'storage/invalid-root-operation',
      errorName: 'FirebaseError',
      isFirebaseError: true,
      fetchCalls: 0,
    });

    for (const entry of SDK_PROBES) {
      if (entry.probe.pendingRowLink) {
        expectStagedUntilCaptured(entry.name, {
          rig: 'sdk-probes',
          filterFlag: '--probe',
        });
      }
    }
    for (const entry of CLIENT_STORAGE_PROBES) {
      if (entry.probe.pendingRowLink) {
        expectStagedUntilCaptured(entry.name, {
          rig: 'client-storage',
          filterFlag: '--probe',
        });
      }
    }
  });
});
