import { describe, expect, it } from 'bun:test';
import { getApps } from 'firebase/app';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { probe as refHierarchyProbe } from '../../probes/storage/client-storage-ref-hierarchy-and-traversal.ts';
import { probe as refIdentityProbe } from '../../probes/storage/client-storage-ref-identity-and-storage-handle.ts';
import { probe as refRootSegmentsProbe } from '../../probes/storage/client-storage-ref-root-and-segments.ts';
import { probe as refSlashNormProbe } from '../../probes/storage/client-storage-ref-slash-normalization.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import { loadClientStorageProbes } from '../../src/client-storage-probes.ts';
import { loadObservations } from '../../src/ledger.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';

const LINKED_REF_PROBE_NAMES = [
  'client-storage-ref-root-and-segments',
  'client-storage-ref-slash-normalization',
  'client-storage-ref-hierarchy-and-traversal',
  'client-storage-ref-identity-and-storage-handle',
] as const;

describe('Storage ref() client-storage conformance probes (storage#13..23)', () => {
  it('executes client-storage-ref-root-and-segments and client-storage-ref-slash-normalization cleanly without leaking apps', async () => {
    const rootSegments = await refRootSegmentsProbe.observe();
    expect(getApps()).toEqual([]);
    expect(rootSegments.bareRoot).toEqual({
      bucket: 'buckets-default',
      fullPath: '',
      name: '',
      hasParent: false,
      parentFullPath: null,
      rootFullPath: '',
      toStringValue: 'gs://buckets-default/',
      rootStrictEqualSelf: false,
      rootToStringMatchesSelf: true,
    });
    expect(rootSegments.nestedSegments).toEqual({
      bucket: 'buckets-default',
      fullPath: 'sessions/s1.json',
      name: 's1.json',
      hasParent: true,
      parentFullPath: 'sessions',
      rootFullPath: '',
      toStringValue: 'gs://buckets-default/sessions/s1.json',
    });

    const slashNorm = await refSlashNormProbe.observe();
    expect(getApps()).toEqual([]);
    expect(slashNorm.singleLeadingSlash).toMatchObject({ fullPath: 'sessions/s1', name: 's1' });
    expect(slashNorm.singleTrailingSlash).toMatchObject({ fullPath: 'sessions/s1', name: 's1' });
    expect(slashNorm.repeatedInternalSlashes).toMatchObject({ fullPath: 'a/b', name: 'b' });
    expect(slashNorm.combinedSlashes).toMatchObject({
      fullPath: 'a/b/c',
      name: 'c',
      toStringValue: 'gs://buckets-default/a/b/c',
    });
    expect(slashNorm.onlySlashes).toMatchObject({ fullPath: '', name: '', hasParent: false });
  });

  it('executes client-storage-ref-hierarchy-and-traversal and client-storage-ref-identity-and-storage-handle cleanly', async () => {
    const hierarchy = await refHierarchyProbe.observe();
    expect(getApps()).toEqual([]);
    expect(hierarchy.childFromFolder).toMatchObject({
      fullPath: 'users/u1/avatars/profile.png',
      name: 'profile.png',
      parentFullPath: 'users/u1/avatars',
    });
    expect(hierarchy.slashyChildJoin).toMatchObject({
      fullPath: 'users/u1/avatars/banner.png',
      name: 'banner.png',
    });
    expect(hierarchy.parentChainFromDepth3).toEqual([
      { fullPath: 'alpha/beta/gamma', name: 'gamma' },
      { fullPath: 'alpha/beta', name: 'beta' },
      { fullPath: 'alpha', name: 'alpha' },
      { fullPath: '', name: '' },
    ]);
    expect(hierarchy.terminalParentIsNull).toBe(true);
    expect(hierarchy.rootAtDepth3).toMatchObject({ fullPath: '', name: '', hasParent: false });

    const identity = await refIdentityProbe.observe();
    expect(getApps()).toEqual([]);
    expect(identity).toEqual({
      samePathStrictEqual: false,
      samePathFullPathEqual: true,
      samePathToStringEqual: true,
      rootCallsStrictEqual: false,
      rootGetterOnRootStrictEqualSelf: false,
      repeatedParentGetterStrictEqual: false,
      repeatedParentToStringEqual: true,
      repeatedRootGetterStrictEqual: false,
      repeatedRootToStringEqual: true,
      childJoinToStringMatchesDirect: true,
      childJoinStrictEqualDirect: false,
      directPreservesStorageHandle: true,
      parentPreservesStorageHandle: true,
      rootPreservesStorageHandle: true,
      childJoinPreservesStorageHandle: true,
      bucketPreservedAcrossChain: true,
    });
  });

  it('links all 4 ref() probes and observations to storage#13..23 with zero registry validation problems', async () => {
    const clientProbes = await loadClientStorageProbes();
    const ids = clientProbes.map((item) => item.id);
    for (const name of LINKED_REF_PROBE_NAMES) {
      expect(ids).toContain(name);
    }

    const currentObservations = loadObservations();
    const obsByName = new Map(currentObservations.map((obs) => [obs.name, obs]));

    const expectedLinks = [
      {
        name: 'client-storage-ref-root-and-segments',
        probe: refRootSegmentsProbe,
        rowIds: ['storage#13', 'storage#14', 'storage#21'],
      },
      {
        name: 'client-storage-ref-slash-normalization',
        probe: refSlashNormProbe,
        rowIds: ['storage#15', 'storage#16', 'storage#17'],
      },
      {
        name: 'client-storage-ref-hierarchy-and-traversal',
        probe: refHierarchyProbe,
        rowIds: ['storage#18', 'storage#19', 'storage#20'],
      },
      {
        name: 'client-storage-ref-identity-and-storage-handle',
        probe: refIdentityProbe,
        rowIds: ['storage#22', 'storage#23'],
      },
    ];

    for (const entry of expectedLinks) {
      expect(entry.probe.pendingRowLink).toBeUndefined();
      expect(entry.probe.rowIds).toEqual(entry.rowIds);
      const committed = obsByName.get(entry.name);
      expect(committed).toBeDefined();
      if (committed) {
        expect(committed.rowIds).toEqual(entry.rowIds);
      }
    }

    const rigManifests = await loadRigManifests();
    const rtdbScenarioIds = [
      ...ALL_RULES_RTDB_SCENARIOS.map((s) => s.id),
      ...ALL_RULES_RTDB_DEPLOY_SCENARIOS.map((s) => s.id),
    ];

    const problems = validateCompatibilityRegistry({
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
    expect(problems).toEqual([]);
  });
});
