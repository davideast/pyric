import { describe, expect, it } from 'bun:test';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { probe as getMetadataRootProbe } from '../../probes/storage/client-storage-getmetadata-root-ref.ts';
import { probe as updateMetadataRootProbe } from '../../probes/storage/client-storage-updatemetadata-root-ref.ts';
import {
  observeGetMetadataFullShape,
  probe as getMetadataFullShapeProbe,
  type StorageGetMetadataShapeSubject,
} from '../../probes/storage/storage-getmetadata-full-shape.ts';
import {
  captureMissingMetadataCall,
  observeMetadataMissingObjectErrors,
  probe as missingMetadataProbe,
  type StorageMissingMetadataSubject,
} from '../../probes/storage/storage-metadata-missing-object-errors.ts';
import {
  observeUpdateMetadataFieldsAndBytes,
  probe as updateFieldsProbe,
  type StorageUpdateMetadataFieldsSubject,
} from '../../probes/storage/storage-updatemetadata-fields-and-bytes.ts';
import {
  observeUpdateMetadataVersioningAndTimestamps,
  probe as updateVersioningProbe,
  type StorageUpdateMetadataVersioningSubject,
} from '../../probes/storage/storage-updatemetadata-versioning-and-timestamps.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import { loadClientStorageProbes, selectClientStorageProbes } from '../../src/client-storage-probes.ts';
import { loadObservations } from '../../src/ledger.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';

const LINKED_CLIENT_STORAGE_PROBES = [
  {
    name: 'client-storage-getmetadata-root-ref',
    probe: getMetadataRootProbe,
    expectedRows: ['storage#81'],
  },
  {
    name: 'client-storage-updatemetadata-root-ref',
    probe: updateMetadataRootProbe,
    expectedRows: ['storage#88'],
  },
] as const;

const LINKED_SDK_PROBES = [
  {
    name: 'storage-getmetadata-full-shape',
    probe: getMetadataFullShapeProbe,
    expectedRows: ['storage#79'],
  },
  {
    name: 'storage-metadata-missing-object-errors',
    probe: missingMetadataProbe,
    expectedRows: ['storage#80', 'storage#87'],
  },
  {
    name: 'storage-updatemetadata-fields-and-bytes',
    probe: updateFieldsProbe,
    expectedRows: ['storage#82', 'storage#85'],
  },
  {
    name: 'storage-updatemetadata-versioning-and-timestamps',
    probe: updateVersioningProbe,
    expectedRows: ['storage#83', 'storage#84'],
  },
] as const;

describe('Storage metadata conformance probes (storage#79..85, #87, #88)', () => {
  it('client-storage-getmetadata-root-ref and client-storage-updatemetadata-root-ref observe synchronous invalid-root-operation with zero fetches', async () => {
    const getObs = await getMetadataRootProbe.observe();
    expect(getObs.rootFullPath).toBe('');
    expect(getObs.rootName).toBe('');
    expect(getObs.threw).toBe(true);
    expect(getObs.threwSynchronously).toBe(true);
    expect(getObs.code).toBe('storage/invalid-root-operation');
    expect(getObs.isFirebaseError).toBe(true);
    expect(getObs.fetchCalls).toBe(0);

    const updateObs = await updateMetadataRootProbe.observe();
    expect(updateObs.rootFullPath).toBe('');
    expect(updateObs.rootName).toBe('');
    expect(updateObs.threw).toBe(true);
    expect(updateObs.threwSynchronously).toBe(true);
    expect(updateObs.code).toBe('storage/invalid-root-operation');
    expect(updateObs.isFirebaseError).toBe(true);
    expect(updateObs.fetchCalls).toBe(0);
  });

  it('storage-getmetadata-full-shape and storage-metadata-missing-object-errors observe FullMetadata parity and missing-object errors', async () => {
    const baseShape = {
      name: 'doc.json',
      scrubbedFullPath: 'pyric_oracle/<runId>/metadata-full-shape/doc.json',
      size: 7,
      metageneration: '1',
      contentType: 'application/json',
      cacheControl: 'public, max-age=300',
      contentDisposition: 'inline; filename="doc.json"',
      contentEncoding: 'identity',
      contentLanguage: 'en',
      customMetadata: { owner: 'user-1', tier: 'standard' },
      bucketMatchesHandle: true,
      generationIsDigits: true,
    };
    const shapeSubject: StorageGetMetadataShapeSubject = {
      async uploadAndFetchFullShape() {
        return {
          uploadedShape: baseShape,
          fetchedShape: {
            ...baseShape,
            generationMatchesUpload: true,
            timeCreatedMatchesUpload: true,
            updatedMatchesUpload: true,
          },
        };
      },
    };
    const shapeObs = await observeGetMetadataFullShape(shapeSubject);
    expect(shapeObs.uploadedShape).toEqual(baseShape);
    expect(shapeObs.fetchedShape).toMatchObject({
      generationMatchesUpload: true,
      timeCreatedMatchesUpload: true,
      updatedMatchesUpload: true,
    });

    const makeNotFound = () => {
      const err = new Error('not found') as Error & { code: string };
      err.name = 'FirebaseError';
      err.code = 'storage/object-not-found';
      return err;
    };
    const missingSubject: StorageMissingMetadataSubject = {
      async attemptGetMissing() {
        return captureMissingMetadataCall(async () => {
          throw makeNotFound();
        });
      },
      async attemptUpdateMissing() {
        return captureMissingMetadataCall(async () => {
          throw makeNotFound();
        });
      },
    };
    const missingObs = await observeMetadataMissingObjectErrors(missingSubject);
    expect(missingObs).toEqual({
      getMetadataMissing: {
        threw: true,
        code: 'storage/object-not-found',
        errorName: 'FirebaseError',
        isFirebaseError: true,
      },
      updateMetadataMissing: {
        threw: true,
        code: 'storage/object-not-found',
        errorName: 'FirebaseError',
        isFirebaseError: true,
      },
    });
  });

  it('storage-updatemetadata-fields-and-bytes and versioning probes observe wholesale field replacement, byte preservation, and metageneration bumps', async () => {
    const fieldsSubject: StorageUpdateMetadataFieldsSubject = {
      async uploadUpdateAndReadBack() {
        const updatedFields = {
          size: 5,
          contentType: 'application/octet-stream',
          cacheControl: 'public, max-age=60',
          contentDisposition: 'attachment; filename="item.bin"',
          contentEncoding: 'identity',
          contentLanguage: 'fr',
          customMetadata: { k2: 'v2-next', k3: 'v3' },
        };
        return {
          initialBytes: [222, 173, 190, 239, 33],
          beforeUpdate: {
            size: 5,
            contentType: 'text/plain',
            cacheControl: 'no-cache',
            contentDisposition: 'inline',
            contentEncoding: 'identity',
            contentLanguage: 'en',
            customMetadata: { k1: 'v1', k2: 'v2' },
          },
          updateReturn: updatedFields,
          afterGetMetadata: updatedFields,
          afterReadBytes: [222, 173, 190, 239, 33],
        };
      },
    };
    const fieldsObs = await observeUpdateMetadataFieldsAndBytes(fieldsSubject);
    expect(fieldsObs.afterReadBytes).toEqual([222, 173, 190, 239, 33]);
    expect(fieldsObs.afterGetMetadata).toMatchObject({
      customMetadata: { k2: 'v2-next', k3: 'v3' },
    });

    const versioningSubject: StorageUpdateMetadataVersioningSubject = {
      async uploadAndUpdateTwice() {
        return {
          initial: {
            generation: '1700000000000000',
            metageneration: '1',
            timeCreated: '2026-11-18T00:00:00.000Z',
            updated: '2026-11-18T00:00:00.000Z',
          },
          firstUpdate: {
            generation: '1700000000000000',
            metageneration: '2',
            timeCreated: '2026-11-18T00:00:00.000Z',
            updated: '2026-11-18T00:00:00.050Z',
          },
          secondUpdate: {
            generation: '1700000000000000',
            metageneration: '3',
            timeCreated: '2026-11-18T00:00:00.000Z',
            updated: '2026-11-18T00:00:00.100Z',
          },
        };
      },
    };
    const verObs = await observeUpdateMetadataVersioningAndTimestamps(versioningSubject);
    expect(verObs).toEqual({
      initialMetageneration: '1',
      firstUpdateMetageneration: '2',
      secondUpdateMetageneration: '3',
      generationIsDigits: true,
      generationPinnedAcrossUpdates: true,
      timeCreatedPinnedAcrossUpdates: true,
      isoTimestampsValid: true,
      firstUpdatedNotBeforeTimeCreated: true,
      firstUpdatedNotBeforeInitialUpdated: true,
      secondUpdatedStrictlyAfterInitialUpdated: true,
      secondUpdatedNotBeforeFirstUpdated: true,
    });
  });

  it('links all 6 metadata probes and observations to storage#79..85, #87, #88 with zero validation problems', async () => {
    const observationsByName = new Map(loadObservations().map((obs) => [obs.name, obs]));

    const clientProbes = await loadClientStorageProbes();
    const clientIds = clientProbes.map((item) => item.id);
    for (const entry of LINKED_CLIENT_STORAGE_PROBES) {
      expect(clientIds).toContain(entry.name);
      expect(entry.probe.pendingRowLink).toBeUndefined();
      expect(entry.probe.rowIds).toEqual([...entry.expectedRows]);
      expect(observationsByName.get(entry.name)?.rowIds).toEqual([...entry.expectedRows]);
      expect(
        selectClientStorageProbes(clientProbes, ['--probe', entry.name]).map((p) => p.id),
      ).toEqual([entry.name]);
    }

    const sdkProbes = await loadModularProbes('sdk-probes');
    const sdkIds = sdkProbes.map((item) => item.id);
    for (const entry of LINKED_SDK_PROBES) {
      expect(sdkIds).toContain(entry.name);
      expect(entry.probe.requires).toEqual(['web-config']);
      expect(entry.probe.pendingRowLink).toBeUndefined();
      expect(entry.probe.rowIds).toEqual([...entry.expectedRows]);
      expect(observationsByName.get(entry.name)?.rowIds).toEqual([...entry.expectedRows]);
    }

    const rigManifests = await loadRigManifests();
    const rtdbScenarioIds = [
      ...ALL_RULES_RTDB_SCENARIOS.map((s) => s.id),
      ...ALL_RULES_RTDB_DEPLOY_SCENARIOS.map((s) => s.id),
    ];

    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: [...observationsByName.values()],
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
