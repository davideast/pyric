import { describe, expect, it } from 'bun:test';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import {
  observeAdminBucketDeleteFiles,
  probe as deleteFilesProbe,
  type AdminBucketDeleteFilesSubject,
} from '../../probes/storage-admin/admin-storage-bucket-deletefiles.ts';
import {
  observeAdminBucketGetFiles,
  probe as getFilesProbe,
  type AdminBucketGetFilesSubject,
  type BucketGetFilesPageObservation,
} from '../../probes/storage-admin/admin-storage-bucket-getfiles.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import { loadObservations, type Observation } from '../../src/ledger.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import {
  loadStorageAdminProbes,
  selectStorageAdminProbes,
  type LoadedStorageAdminProbe,
} from '../../src/storage-admin-probes.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const STAGED_ADMIN_PROBES = [
  { name: 'admin-storage-bucket-getfiles', probe: getFilesProbe },
  { name: 'admin-storage-bucket-deletefiles', probe: deleteFilesProbe },
] as const;

function makeSyntheticObservation(name: string): Observation {
  return {
    file: `${name}.json`,
    surfaceDir: 'storage-admin',
    name,
    matrixRow: '',
    rowIds: [],
    observedAt: '2026-11-18T00:00:00.000Z',
    fbSdkVersion: '13.10.0',
    behavior: { sample: true },
    raw: { adminSdkVersion: '13.10.0', rowIds: [] },
  };
}

describe('storage-admin Bucket.getFiles and Bucket.deleteFiles probes (storage-admin#7, #8)', () => {
  it('observeAdminBucketGetFiles records verbatim prefix, delimiter roll-up, tuple shape, and two-page pagination', async () => {
    const seeded = new Set<string>();
    const makePage = (
      relativeNames: string[],
      relativePrefixes: string[],
      nextQueryIsNull: boolean,
      nextQueryHasPageToken: boolean,
      nextQueryMatchesInputPrefix: boolean,
    ): BucketGetFilesPageObservation => {
      let firstFileMetadataPopulated: boolean | null = null;
      if (relativeNames.length > 0) {
        firstFileMetadataPopulated = true;
      }
      return {
        relativeNames,
        relativePrefixes,
        nextQueryIsNull,
        nextQueryHasPageToken,
        nextQueryMatchesInputPrefix,
        apiResponseKind: 'storage#objects',
        apiResponseHasItemsProperty: false,
        firstFileMetadataPopulated,
      };
    };

    const subject: AdminBucketGetFilesSubject = {
      async seedRelative(rel) {
        seeded.add(rel);
      },
      async queryVerbatimSubPrefix(sub) {
        const names = [...seeded].filter((n) => n.startsWith(sub)).sort();
        return makePage(names, [], false, false, true);
      },
      async queryDelimiterRoot() {
        return makePage(['items', 'readme.txt'], ['items/'], false, false, true);
      },
      async queryTwoPagesWithDelimiter() {
        return {
          page1: makePage(['items', 'readme.txt'], [], false, true, true),
          page2: makePage([], ['items/'], true, false, false),
        };
      },
    };

    const observed = await observeAdminBucketGetFiles(subject);
    expect(observed.partialFolderPrefix).toMatchObject({
      relativeNames: ['items/123/a.bin', 'items/123/b/c.bin', 'items/124/a.bin'],
    });
    expect(observed.slashFolderPrefix).toMatchObject({
      relativeNames: ['items/123/a.bin', 'items/123/b/c.bin'],
    });
    expect(observed.delimiterRollup).toMatchObject({
      relativeNames: ['items', 'readme.txt'],
      relativePrefixes: ['items/'],
    });
  });

  it('observeAdminBucketDeleteFiles records maxResults cap, full prefix delete, sibling isolation, and empty prefix no-op', async () => {
    const store = new Set<string>();
    const subject: AdminBucketDeleteFilesSubject = {
      async seedRelative(rel) {
        store.add(rel);
      },
      async existsRelative(rel) {
        return store.has(rel);
      },
      async deleteSubPrefix(subPrefix, options) {
        const matching = [...store].filter((rel) => rel.startsWith(subPrefix)).sort();
        const limit = options?.maxResults ?? matching.length;
        for (const rel of matching.slice(0, limit)) {
          store.delete(rel);
        }
      },
    };

    const observed = await observeAdminBucketDeleteFiles(subject);
    expect(observed).toEqual({
      cappedMaxResults2: {
        seededCount: 3,
        remainingRelativeNames: ['capped/c.bin'],
        siblingStillExists: true,
      },
      fullPrefixDelete: {
        seededCount: 2,
        remainingRelativeNames: [],
        siblingStillExists: true,
      },
      emptyPrefixDelete: {
        threw: false,
      },
    });
  });

  it('discovers staged storage-admin probes via loadStorageAdminProbes and expectStagedUntilCaptured', async () => {
    const loaded = await loadStorageAdminProbes();
    const ids = loaded.map((item) => item.id);
    expect(ids).toContain('admin-storage-metadata-download-url');

    for (const entry of STAGED_ADMIN_PROBES) {
      expect(ids).toContain(entry.name);
      expect(
        selectStorageAdminProbes(loaded, ['--write', '--probe', entry.name]).map((p) => p.id),
      ).toEqual([entry.name]);
      if (entry.probe.pendingRowLink) {
        expectStagedUntilCaptured(entry.name, {
          rig: 'storage-admin',
          filterFlag: '--probe',
        });
      }
    }

    const unfilteredWhenUncaptured = selectStorageAdminProbes(
      loaded,
      ['--write'],
      (id) => {
        if (id === 'admin-storage-metadata-download-url') {
          return import.meta.path;
        }
        return `/nonexistent/${id}.json`;
      },
    );
    expect(unfilteredWhenUncaptured.map((p) => p.id)).toEqual([
      'admin-storage-metadata-download-url',
    ]);

    const rigManifests = await loadRigManifests();
    const rtdbScenarioIds = [
      ...ALL_RULES_RTDB_SCENARIOS.map((s) => s.id),
      ...ALL_RULES_RTDB_DEPLOY_SCENARIOS.map((s) => s.id),
    ];
    const currentObservations = loadObservations();

    const preCaptureProblems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: currentObservations,
      observationExceptions,
      rigManifests,
      probeFiles: listProbeFiles(),
      rulesFirestoreScenarioIds: ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id),
      rulesStorageScenarioIds: ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id),
      rulesRtdbScenarioIds: rtdbScenarioIds,
      pendingRowLinkObservations: loadPendingRowLinkObservations(),
    });
    expect(preCaptureProblems).toEqual([]);

    const simulatedMap = new Map(currentObservations.map((obs) => [obs.name, obs]));
    for (const entry of STAGED_ADMIN_PROBES) {
      if (!simulatedMap.has(entry.name)) {
        simulatedMap.set(entry.name, makeSyntheticObservation(entry.name));
      }
    }
    const simulatedPending = new Set([
      ...loadPendingRowLinkObservations(),
      ...STAGED_ADMIN_PROBES.map((e) => e.name),
    ]);
    const pr2Problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: [...simulatedMap.values()],
      observationExceptions,
      rigManifests,
      probeFiles: listProbeFiles(),
      rulesFirestoreScenarioIds: ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id),
      rulesStorageScenarioIds: ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id),
      rulesRtdbScenarioIds: rtdbScenarioIds,
      pendingRowLinkObservations: simulatedPending,
    });
    expect(pr2Problems).toEqual([]);
  });
});
