import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface ListedRefSnapshot {
  name: string;
  scrubbedFullPath: string;
  storageMatchesHandle: boolean;
  bucketMatchesHandle: boolean;
  parentMatchesScannedRef: boolean;
  rootFullPath: string;
  toStringMatchesGsUri: boolean;
}

interface ListResultSnapshot {
  items: ListedRefSnapshot[];
  prefixes: ListedRefSnapshot[];
  nextPageTokenIsUndefined: boolean;
  hasNextPageTokenOwnProperty: boolean;
}

export interface StorageListAllResultShapeSubject {
  listDirectory(subpath: string): Promise<ListResultSnapshot>;
  uploadMarker(subpath: string): Promise<void>;
}

export async function observeListAllEmptyAndResultShape(
  subject: StorageListAllResultShapeSubject,
): Promise<Record<string, unknown>> {
  const emptyDir = await subject.listDirectory('listall-shape-empty');

  await subject.uploadMarker('listall-shape-populated/direct.bin');
  await subject.uploadMarker('listall-shape-populated/nested-folder/child.bin');
  const populatedDir = await subject.listDirectory('listall-shape-populated');

  return {
    emptyDirectory: {
      itemCount: emptyDir.items.length,
      prefixCount: emptyDir.prefixes.length,
      nextPageTokenIsUndefined: emptyDir.nextPageTokenIsUndefined,
      hasNextPageTokenOwnProperty: emptyDir.hasNextPageTokenOwnProperty,
    },
    populatedDirectory: {
      itemCount: populatedDir.items.length,
      prefixCount: populatedDir.prefixes.length,
      nextPageTokenIsUndefined: populatedDir.nextPageTokenIsUndefined,
      hasNextPageTokenOwnProperty: populatedDir.hasNextPageTokenOwnProperty,
      items: populatedDir.items,
      prefixes: populatedDir.prefixes,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'listAll(ref) on empty and populated directories: observes empty items/prefixes arrays, undefined nextPageToken, and full StorageReference properties (storage, bucket, name, fullPath, parent, root, toString) on returned items and prefixes.',
  async observe() {
    return withStorageProbeSession(
      async ({ storage, storageBucket, objectPath, objectRef, storageSdk, scrubRunPath }) => {
        const snapshotRef = (
          entry: import('firebase/storage').StorageReference,
          scannedFullPath: string,
        ): ListedRefSnapshot => {
          let parentMatches = false;
          if (entry.parent !== null) {
            parentMatches = entry.parent.fullPath === scannedFullPath;
          }
          const expectedGsUri = `gs://${storageBucket}/${entry.fullPath}`;
          return {
            name: entry.name,
            scrubbedFullPath: scrubRunPath(entry.fullPath),
            storageMatchesHandle: entry.storage === storage,
            bucketMatchesHandle: entry.bucket === storageBucket,
            parentMatchesScannedRef: parentMatches,
            rootFullPath: entry.root.fullPath,
            toStringMatchesGsUri: entry.toString() === expectedGsUri,
          };
        };

        return observeListAllEmptyAndResultShape({
          async uploadMarker(subpath) {
            await storageSdk.uploadBytes(objectRef(subpath), new Uint8Array([0x01]));
          },
          async listDirectory(subpath) {
            const scannedFullPath = objectPath(subpath);
            const dirRef = storageSdk.ref(storage, scannedFullPath);
            const result = await storageSdk.listAll(dirRef);
            const rawRecord = result as unknown as Record<string, unknown>;
            return {
              items: result.items.map((item) => snapshotRef(item, scannedFullPath)),
              prefixes: result.prefixes.map((prefix) => snapshotRef(prefix, scannedFullPath)),
              nextPageTokenIsUndefined: rawRecord.nextPageToken === undefined,
              hasNextPageTokenOwnProperty: Object.prototype.hasOwnProperty.call(
                rawRecord,
                'nextPageToken',
              ),
            };
          },
        });
      },
    );
  },
};
