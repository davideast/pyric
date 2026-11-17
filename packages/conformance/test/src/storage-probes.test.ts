import { describe, expect, it } from 'bun:test';
import { getApps } from 'firebase/app';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { probe as getBlobRootProbe } from '../../probes/storage/client-storage-getblob-root-ref.ts';
import {
  observeDeleteThenGetMetadata,
  probe as deleteThenGetMetadataProbe,
  type StorageDeleteMetadataSubject,
} from '../../probes/storage/storage-delete-then-getmetadata-throws.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import {
  captureClientStorageObservation,
  loadClientStorageProbes,
  selectClientStorageProbes,
} from '../../src/client-storage-probes.ts';
import { loadObservations, type Observation } from '../../src/ledger.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import {
  discoverUncapturedStagedTargets,
  loadPendingRowLinkObservations,
} from '../../src/staged-captures.ts';
import {
  extractObservedErrorDetails,
  normalizeStorageProbeSubpath,
  resolveProbeStorageBucket,
  scrubStorageOracleRunPath,
} from '../../src/storage-probe-session.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';

function makeSyntheticObservation(
  surfaceDir: string,
  name: string,
  rowIds: readonly string[] = [],
): Observation {
  return {
    file: `${name}.json`,
    surfaceDir,
    name,
    matrixRow: '',
    rowIds: [...rowIds],
    observedAt: '2026-11-17T00:00:00.000Z',
    fbSdkVersion: '12.19.0',
    behavior: { sample: true },
    raw: { fbSdkVersion: '12.19.0', rowIds: [...rowIds] },
  };
}

describe('Storage conformance probes (storage#61 and storage#67)', () => {
  it('discovers client-storage probes, skips uncaptured staged probes when unfiltered, and selects explicit --probe targets', async () => {
    const loaded = await loadClientStorageProbes();
    const ids = loaded.map((item) => item.id);
    expect(ids).toContain('client-storage-ref-urls');
    expect(ids).toContain('client-storage-getblob-root-ref');

    const withStagedSample = [
      ...loaded,
      {
        id: 'client-storage-staged-sample',
        probe: {
          rig: 'client-storage' as const,
          pendingRowLink: true,
          matrixRow: '',
          rowIds: [],
          description: 'sample staged client-storage probe',
          observe: async () => ({ ok: true }),
        },
      },
    ];
    const capturedSet = new Set(loaded.map((item) => item.id));
    const unfiltered = selectClientStorageProbes(withStagedSample, ['--write'], (id) =>
      capturedSet.has(id),
    );
    expect(unfiltered.map((item) => item.id)).toEqual(loaded.map((item) => item.id));

    const explicitStaged = selectClientStorageProbes(
      withStagedSample,
      ['--write', '--probe', 'client-storage-staged-sample'],
      (id) => capturedSet.has(id),
    );
    expect(explicitStaged.map((item) => item.id)).toEqual(['client-storage-staged-sample']);

    const afterCaptureSet = new Set([...loaded.map((item) => item.id), 'client-storage-staged-sample']);
    const unfilteredAfterCapture = selectClientStorageProbes(withStagedSample, [], (id) =>
      afterCaptureSet.has(id),
    );
    expect(unfilteredAfterCapture.map((item) => item.id)).toEqual([
      ...loaded.map((item) => item.id),
      'client-storage-staged-sample',
    ]);

    expect(() =>
      selectClientStorageProbes(loaded, ['--probe', 'unknown-client-storage'], () => true),
    ).toThrow(/unknown client-storage probe: unknown-client-storage/);

    const preservedEnvelope = await captureClientStorageObservation(
      {
        description: 'sample',
        matrixRow: '',
        rowIds: [],
        observe: async () => ({ ok: true, dropped: undefined }),
      },
      '12.19.0',
      'client-storage-getblob-root-ref',
      { matrixRow: 'storage #61', rowIds: ['storage#61'] },
    );
    expect(preservedEnvelope.name).toBe('client-storage-getblob-root-ref');
    expect(preservedEnvelope.matrixRow).toBe('storage #61');
    expect(preservedEnvelope.rowIds).toEqual(['storage#61']);
    expect(preservedEnvelope.behavior).toEqual({ ok: true });
  });

  it('client-storage-getblob-root-ref observes browser invalid-root-operation and node guard with zero network calls', async () => {
    expect(getBlobRootProbe.rig).toBe('client-storage');
    expect(getBlobRootProbe.description.length).toBeGreaterThan(10);

    const behavior = await getBlobRootProbe.observe();
    expect(getApps()).toEqual([]);

    const browserRoot = behavior.browserRootRef as Record<string, unknown>;
    expect(browserRoot.rootFullPath).toBe('');
    expect(browserRoot.rootName).toBe('');
    expect(browserRoot.threw).toBe(true);
    expect(browserRoot.threwSynchronously).toBe(true);
    expect(browserRoot.code).toBe('storage/invalid-root-operation');
    expect(browserRoot.isFirebaseError).toBe(true);
    expect(browserRoot.fetchCalls).toBe(0);

    const nodeRoot = behavior.nodeEntryRootRef as Record<string, unknown>;
    expect(nodeRoot.threw).toBe(true);
    expect(nodeRoot.threwSynchronously).toBe(true);
    expect(nodeRoot.fetchCalls).toBe(0);
  });

  it('storage-probe-session resolves bucket config, rejects unsafe subpaths, and scrubs dynamic runId paths', () => {
    expect(
      resolveProbeStorageBucket(
        {
          apiKey: 'k',
          authDomain: 'example.firebaseapp.com',
          projectId: 'example',
          storageBucket: 'example.firebasestorage.app',
        },
        {},
      ),
    ).toBe('example.firebasestorage.app');

    expect(
      resolveProbeStorageBucket(
        {
          apiKey: 'k',
          authDomain: 'example.firebaseapp.com',
          projectId: 'example',
          storageBucket: 'example.firebasestorage.app',
        },
        { PYRIC_ORACLE_STORAGE_BUCKET: 'gs://override-bucket/' },
      ),
    ).toBe('override-bucket');

    expect(() =>
      resolveProbeStorageBucket(
        {
          apiKey: 'k',
          authDomain: 'example.firebaseapp.com',
          projectId: 'example',
        },
        { PYRIC_ORACLE_STORAGE_BUCKET: '   ' },
      ),
    ).toThrow(/storageBucket.*PYRIC_ORACLE_STORAGE_BUCKET/);

    expect(normalizeStorageProbeSubpath('/delete-check/item.bin')).toBe('delete-check/item.bin');
    expect(() => normalizeStorageProbeSubpath('')).toThrow(/non-empty/);
    expect(() => normalizeStorageProbeSubpath('../escape.bin')).toThrow(/relative subpath/);

    expect(
      scrubStorageOracleRunPath(
        "Firebase Storage: Object 'pyric_oracle/st_mabc123_xyz987/items/doc.bin' does not exist. (storage/object-not-found)",
        'st_mabc123_xyz987',
      ),
    ).toBe(
      "Firebase Storage: Object 'pyric_oracle/<runId>/items/doc.bin' does not exist. (storage/object-not-found)",
    );

    const fbErr = Object.assign(new Error('root op denied'), {
      name: 'FirebaseError',
      code: 'storage/invalid-root-operation',
    });
    expect(extractObservedErrorDetails(fbErr)).toEqual({
      code: 'storage/invalid-root-operation',
      errorName: 'FirebaseError',
      isFirebaseError: true,
      message: 'root op denied',
    });
    expect(extractObservedErrorDetails('raw string error')).toEqual({
      code: null,
      errorName: null,
      isFirebaseError: false,
      message: 'raw string error',
    });
  });

  it('storage-delete-then-getmetadata-throws observes pre-delete metadata and post-delete object-not-found while propagating setup errors', async () => {
    expect(deleteThenGetMetadataProbe.rig).toBe('sdk-probes');
    expect(deleteThenGetMetadataProbe.requires).toEqual(['web-config']);
    const sdkProbes = await loadModularProbes('sdk-probes');
    expect(sdkProbes.map((item) => item.id)).toContain('storage-delete-then-getmetadata-throws');

    let stored: {
      size: number;
      contentType: string | null;
      customMetadata: Record<string, string> | null;
      generation: string;
      metageneration: string;
    } | null = null;

    const fakeSubject: StorageDeleteMetadataSubject = {
      async uploadObject(bytes, metadata) {
        stored = {
          size: bytes.byteLength,
          contentType: metadata.contentType,
          customMetadata: { ...metadata.customMetadata },
          generation: '1001',
          metageneration: '1',
        };
      },
      async readMetadata() {
        if (!stored) {
          const err = new Error(
            "Firebase Storage: Object 'pyric_oracle/st_run_1/delete-then-getmetadata/ephemeral.bin' does not exist. (storage/object-not-found)",
          ) as Error & { code: string };
          err.name = 'FirebaseError';
          err.code = 'storage/object-not-found';
          throw err;
        }
        return stored;
      },
      async removeObject() {
        if (!stored) {
          throw new Error('missing object on delete');
        }
        stored = null;
      },
      scrubRunPath(text: string): string {
        return scrubStorageOracleRunPath(text, 'st_run_1');
      },
    };

    const observed = await observeDeleteThenGetMetadata(fakeSubject);
    expect(observed).toEqual({
      beforeDelete: {
        size: 5,
        contentType: 'application/octet-stream',
        customMetadata: { stage: 'before-delete' },
        hasGeneration: true,
        metageneration: '1',
      },
      deleteCompleted: true,
      afterDeleteGetMetadata: {
        threw: true,
        code: 'storage/object-not-found',
        errorName: 'FirebaseError',
        isFirebaseError: true,
        message:
          "Firebase Storage: Object 'pyric_oracle/<runId>/delete-then-getmetadata/ephemeral.bin' does not exist. (storage/object-not-found)",
      },
    });

    const failingUploadSubject: StorageDeleteMetadataSubject = {
      ...fakeSubject,
      async uploadObject() {
        throw new Error('storage/unauthorized: setup denied');
      },
    };
    await expect(observeDeleteThenGetMetadata(failingUploadSubject)).rejects.toThrow(
      /storage\/unauthorized: setup denied/,
    );
  });

  it('validates linked storage#61 and storage#67 probes alongside synthetic pendingRowLink observations', async () => {
    expect(getBlobRootProbe.pendingRowLink).toBeUndefined();
    expect(getBlobRootProbe.matrixRow).toBe('storage #61');
    expect(getBlobRootProbe.rowIds).toEqual(['storage#61']);
    expect(deleteThenGetMetadataProbe.pendingRowLink).toBeUndefined();
    expect(deleteThenGetMetadataProbe.matrixRow).toBe('storage #67');
    expect(deleteThenGetMetadataProbe.rowIds).toEqual(['storage#67']);

    const currentObservations = loadObservations();
    const uncaptured = discoverUncapturedStagedTargets();
    expect(uncaptured.map((item) => item.observationName)).not.toContain(
      'client-storage-getblob-root-ref',
    );
    expect(uncaptured.map((item) => item.observationName)).not.toContain(
      'storage-delete-then-getmetadata-throws',
    );

    const rigManifests = await loadRigManifests();
    const rtdbScenarioIds = [
      ...ALL_RULES_RTDB_SCENARIOS.map((s) => s.id),
      ...ALL_RULES_RTDB_DEPLOY_SCENARIOS.map((s) => s.id),
    ];

    const linkedProblems = validateCompatibilityRegistry({
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
    expect(linkedProblems).toEqual([]);

    const syntheticPending = new Set([
      ...loadPendingRowLinkObservations(),
      'storage-synthetic-staged-probe',
    ]);
    const pr2Problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: [
        ...currentObservations,
        makeSyntheticObservation('storage', 'storage-synthetic-staged-probe'),
      ],
      observationExceptions,
      rigManifests,
      probeFiles: listProbeFiles(),
      rulesFirestoreScenarioIds: ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id),
      rulesStorageScenarioIds: ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id),
      rulesRtdbScenarioIds: rtdbScenarioIds,
      pendingRowLinkObservations: syntheticPending,
    });
    expect(pr2Problems).toEqual([]);
  });
});
