import { describe, expect, it } from 'bun:test';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import {
  observeListAllEmptyAndResultShape,
  probe as listAllShapeProbe,
  type StorageListAllResultShapeSubject,
} from '../../probes/storage/storage-listall-empty-and-result-shape.ts';
import {
  observeListAllHierarchyDedupAndSelfExclusion,
  probe as listAllHierarchyProbe,
  type StorageListAllHierarchySubject,
} from '../../probes/storage/storage-listall-hierarchy-dedup-and-self-exclusion.ts';
import {
  observeListAllLexicographicOrder,
  probe as listAllOrderProbe,
  type StorageListAllOrderSubject,
} from '../../probes/storage/storage-listall-lexicographic-order.ts';
import {
  captureListAttempt,
  observeListAllRulesEnforcement,
  probe as listAllRulesProbe,
  type StorageListAllRulesSubject,
} from '../../probes/storage/storage-listall-rules-enforcement.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import { loadObservations } from '../../src/ledger.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';

const LINKED_LISTALL_PROBES = [
  {
    name: 'storage-listall-empty-and-result-shape',
    probe: listAllShapeProbe,
    matrixRow: 'storage#68',
    rowIds: ['storage#68', 'storage#69', 'storage#76'],
  },
  {
    name: 'storage-listall-hierarchy-dedup-and-self-exclusion',
    probe: listAllHierarchyProbe,
    matrixRow: 'storage#70',
    rowIds: ['storage#70', 'storage#71', 'storage#74'],
  },
  {
    name: 'storage-listall-lexicographic-order',
    probe: listAllOrderProbe,
    matrixRow: 'storage#72',
    rowIds: ['storage#72', 'storage#73'],
  },
  {
    name: 'storage-listall-rules-enforcement',
    probe: listAllRulesProbe,
    matrixRow: 'storage#77a',
    rowIds: ['storage#77a'],
  },
] as const;

describe('Storage listAll() conformance probes (storage#68..74, #76, #77a)', () => {
  it('storage-listall-empty-and-result-shape observes empty directory and StorageReference fields on items and prefixes', async () => {
    const storedPaths = new Set<string>();
    const subject: StorageListAllResultShapeSubject = {
      async uploadMarker(subpath) {
        storedPaths.add(subpath);
      },
      async listDirectory(subpath) {
        const prefix = `${subpath}/`;
        const items: Array<{
          name: string;
          scrubbedFullPath: string;
          storageMatchesHandle: boolean;
          bucketMatchesHandle: boolean;
          parentMatchesScannedRef: boolean;
          rootFullPath: string;
          toStringMatchesGsUri: boolean;
        }> = [];
        const subFolders = new Set<string>();
        for (const p of [...storedPaths].sort()) {
          if (!p.startsWith(prefix)) continue;
          const rel = p.slice(prefix.length);
          const slashIdx = rel.indexOf('/');
          if (slashIdx === -1) {
            items.push({
              name: rel,
              scrubbedFullPath: `pyric_oracle/<runId>/${p}`,
              storageMatchesHandle: true,
              bucketMatchesHandle: true,
              parentMatchesScannedRef: true,
              rootFullPath: '',
              toStringMatchesGsUri: true,
            });
          } else {
            subFolders.add(rel.slice(0, slashIdx));
          }
        }
        const prefixes = [...subFolders].sort().map((folder) => ({
          name: folder,
          scrubbedFullPath: `pyric_oracle/<runId>/${subpath}/${folder}`,
          storageMatchesHandle: true,
          bucketMatchesHandle: true,
          parentMatchesScannedRef: true,
          rootFullPath: '',
          toStringMatchesGsUri: true,
        }));
        return {
          items,
          prefixes,
          nextPageTokenIsUndefined: true,
          hasNextPageTokenOwnProperty: false,
        };
      },
    };

    const observed = await observeListAllEmptyAndResultShape(subject);
    expect(observed.emptyDirectory).toEqual({
      itemCount: 0,
      prefixCount: 0,
      nextPageTokenIsUndefined: true,
      hasNextPageTokenOwnProperty: false,
    });
    expect(observed.populatedDirectory).toMatchObject({
      itemCount: 1,
      prefixCount: 1,
      nextPageTokenIsUndefined: true,
      hasNextPageTokenOwnProperty: false,
    });
  });

  it('storage-listall-hierarchy-dedup-and-self-exclusion and storage-listall-lexicographic-order observe tree and sort invariants', async () => {
    const uploaded = new Set<string>();
    const listHelper = (subpath: string) => {
      const scannedFullPath = `pyric_oracle/r1/${subpath}`;
      const prefix = `${scannedFullPath}/`;
      const itemFullPaths: string[] = [];
      const itemNames: string[] = [];
      const prefixSet = new Set<string>();
      for (const full of [...uploaded].sort()) {
        if (!full.startsWith(prefix)) continue;
        const rel = full.slice(prefix.length);
        const slash = rel.indexOf('/');
        if (slash === -1) {
          itemFullPaths.push(full);
          itemNames.push(rel);
        } else {
          prefixSet.add(rel.slice(0, slash));
        }
      }
      return {
        scannedFullPath,
        itemFullPaths,
        itemNames,
        prefixNames: [...prefixSet].sort(),
      };
    };

    const hierarchySubject: StorageListAllHierarchySubject = {
      async uploadMarker(subpath) {
        uploaded.add(`pyric_oracle/r1/${subpath}`);
      },
      async readObjectSize(subpath) {
        if (uploaded.has(`pyric_oracle/r1/${subpath}`)) {
          return 3;
        }
        throw new Error('missing');
      },
      async listNames(subpath) {
        return listHelper(subpath);
      },
    };

    const hierarchy = await observeListAllHierarchyDedupAndSelfExclusion(hierarchySubject);
    expect(hierarchy).toEqual({
      exactPrefixObjectExists: true,
      scannedRefIncludedInItems: false,
      grandchildrenIncludedInItems: false,
      itemNames: ['direct-one.bin', 'direct-two.bin'],
      prefixNames: ['deep-folder', 'shared-folder'],
    });

    const orderSubject: StorageListAllOrderSubject = {
      async uploadMarker(subpath) {
        uploaded.add(`pyric_oracle/r1/${subpath}`);
      },
      async listItemAndPrefixNames(subpath) {
        const res = listHelper(subpath);
        return { itemNames: res.itemNames, prefixNames: res.prefixNames };
      },
    };

    const order = await observeListAllLexicographicOrder(orderSubject);
    expect(order).toEqual({
      uploadedItemOrder: ['z.bin', 'a.bin', '10.bin', '2.bin', 'B.bin'],
      uploadedPrefixOrder: ['p-z', 'p-a', 'p-10', 'p-2', 'p-B'],
      observedItemNames: ['10.bin', '2.bin', 'B.bin', 'a.bin', 'z.bin'],
      observedPrefixNames: ['p-10', 'p-2', 'p-B', 'p-a', 'p-z'],
    });
  });

  it('storage-listall-rules-enforcement observes allowed listAll and unauthorized denials', async () => {
    const makeUnauthorized = () => {
      const err = new Error('denied') as Error & { code: string };
      err.name = 'FirebaseError';
      err.code = 'storage/unauthorized';
      return err;
    };

    const rulesSubject: StorageListAllRulesSubject = {
      async seedAllowedItem() {},
      async listAllowedAuthenticated() {
        return captureListAttempt(async () => ['visible.bin']);
      },
      async listOutsideGrantAuthenticated() {
        return captureListAttempt(async () => {
          throw makeUnauthorized();
        });
      },
      async listAllowedSignedOut() {
        return captureListAttempt(async () => {
          throw makeUnauthorized();
        });
      },
    };

    const observed = await observeListAllRulesEnforcement(rulesSubject);
    expect(observed).toEqual({
      authenticatedAllowed: {
        threw: false,
        code: null,
        isFirebaseError: false,
        itemNames: ['visible.bin'],
      },
      authenticatedOutsideGrant: {
        threw: true,
        code: 'storage/unauthorized',
        isFirebaseError: true,
        itemNames: [],
      },
      signedOutOnAuthRequiredPath: {
        threw: true,
        code: 'storage/unauthorized',
        isFirebaseError: true,
        itemNames: [],
      },
    });
  });

  it('links all 4 listAll() probes and observations to storage#68..74, #76, #77a with zero registry validation problems', async () => {
    const sdkProbes = await loadModularProbes('sdk-probes');
    const ids = sdkProbes.map((item) => item.id);
    const observationsByName = new Map(loadObservations().map((obs) => [obs.name, obs]));

    for (const entry of LINKED_LISTALL_PROBES) {
      expect(ids).toContain(entry.name);
      expect(entry.probe.requires).toEqual(['web-config']);
      expect(entry.probe.pendingRowLink).toBeUndefined();
      expect(entry.probe.matrixRow).toBe(entry.matrixRow);
      expect(entry.probe.rowIds).toEqual([...entry.rowIds]);

      const obs = observationsByName.get(entry.name);
      expect(obs).toBeDefined();
      if (!obs) continue;
      expect(obs.matrixRow).toBe(entry.matrixRow);
      expect(obs.rowIds).toEqual([...entry.rowIds]);
    }

    const rigManifests = await loadRigManifests();
    const rtdbScenarioIds = [
      ...ALL_RULES_RTDB_SCENARIOS.map((s) => s.id),
      ...ALL_RULES_RTDB_DEPLOY_SCENARIOS.map((s) => s.id),
    ];

    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
      rigManifests,
      probeFiles: listProbeFiles(),
      rulesFirestoreScenarioIds: ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id),
      rulesStorageScenarioIds: ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id),
      rulesRtdbScenarioIds: rtdbScenarioIds,
    });
    expect(problems).toEqual([]);
  });
});
