import { describe, expect, it } from 'bun:test';
import { getApps } from 'firebase/app';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { probe as uploadRootRefProbe } from '../../probes/storage/client-storage-uploadbytes-root-ref.ts';
import {
  observeUploadBytesContentTypePrecedence,
  probe as uploadContentTypeProbe,
  type StorageUploadContentTypeSubject,
} from '../../probes/storage/storage-uploadbytes-contenttype-precedence.ts';
import {
  observeUploadBytesCustomMetadata,
  probe as uploadCustomMetadataProbe,
  type StorageUploadCustomMetadataSubject,
} from '../../probes/storage/storage-uploadbytes-custom-metadata.ts';
import {
  observeUploadBytesOverwriteGenerations,
  probe as uploadOverwriteProbe,
  type StorageUploadOverwriteSubject,
} from '../../probes/storage/storage-uploadbytes-overwrite-generations.ts';
import {
  observeUploadBytesPayloadTypes,
  probe as uploadPayloadTypesProbe,
  type StorageUploadPayloadTypesSubject,
} from '../../probes/storage/storage-uploadbytes-payload-types.ts';
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
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { scrubStorageOracleRunPath } from '../../src/storage-probe-session.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';

describe('Storage uploadBytes conformance probes (storage#24..35, #38, #118)', () => {
  it('client-storage-uploadbytes-root-ref observes synchronous invalid-root-operation with zero network calls', async () => {
    expect(uploadRootRefProbe.rig).toBe('client-storage');
    const clientProbes = await loadClientStorageProbes();
    expect(clientProbes.map((item) => item.id)).toContain('client-storage-uploadbytes-root-ref');

    const behavior = await uploadRootRefProbe.observe();
    expect(getApps()).toEqual([]);

    expect(behavior.rootFullPath).toBe('');
    expect(behavior.rootName).toBe('');
    expect(behavior.threw).toBe(true);
    expect(behavior.threwSynchronously).toBe(true);
    expect(behavior.code).toBe('storage/invalid-root-operation');
    expect(behavior.errorName).toBe('FirebaseError');
    expect(behavior.isFirebaseError).toBe(true);
    expect(behavior.fetchCalls).toBe(0);
  });

  it('storage-uploadbytes-payload-types observes Blob, Uint8Array, and ArrayBuffer uploads with scrubbed paths and exact byte round-trips', async () => {
    expect(uploadPayloadTypesProbe.rig).toBe('sdk-probes');
    expect(uploadPayloadTypesProbe.requires).toEqual(['web-config']);

    const subject: StorageUploadPayloadTypesSubject = {
      expectedBucket: 'buckets-default',
      scrubRunPath: (text) => scrubStorageOracleRunPath(text, 'st_run_payloads'),
      async uploadAndReadBack(subpath, data) {
        let bytes: Uint8Array;
        if (data instanceof Blob) {
          bytes = new Uint8Array(await data.arrayBuffer());
        } else if (data instanceof Uint8Array) {
          bytes = new Uint8Array(data);
        } else {
          bytes = new Uint8Array(data);
        }
        const fullPath = `pyric_oracle/st_run_payloads/${subpath}`;
        const segments = subpath.split('/');
        const name = segments[segments.length - 1] ?? '';
        return {
          expectedFullPath: fullPath,
          expectedName: name,
          observed: {
            resultRefFullPath: fullPath,
            metadataFullPath: fullPath,
            metadataName: name,
            metadataBucket: 'buckets-default',
            metadataSize: bytes.byteLength,
            readBytes: Array.from(bytes),
          },
        };
      },
    };

    const observed = await observeUploadBytesPayloadTypes(subject);
    expect(observed.inputBytes).toEqual([0, 127, 128, 255]);
    expect(observed.blobPayload).toEqual({
      scrubbedFullPath: 'pyric_oracle/<runId>/uploadbytes-payloads/from-blob.bin',
      resultRefMatchesTarget: true,
      metadataFullPathMatchesTarget: true,
      metadataNameMatchesTarget: true,
      metadataName: 'from-blob.bin',
      metadataBucketMatchesHandle: true,
      metadataBucketNonEmpty: true,
      metadataSize: 4,
      readBytes: [0, 127, 128, 255],
    });
    expect(observed.uint8ArrayPayload).toMatchObject({
      metadataName: 'from-uint8array.bin',
      metadataSize: 4,
      readBytes: [0, 127, 128, 255],
    });
    expect(observed.arrayBufferPayload).toMatchObject({
      metadataName: 'from-arraybuffer.bin',
      metadataSize: 4,
      readBytes: [0, 127, 128, 255],
    });
  });

  it('storage-uploadbytes-contenttype-precedence observes caller hint > Blob.type > application/octet-stream while preserving bytes', async () => {
    expect(uploadContentTypeProbe.rig).toBe('sdk-probes');

    const subject: StorageUploadContentTypeSubject = {
      async uploadAndInspect(_subpath, data, metadata) {
        let resolvedType = 'application/octet-stream';
        if (metadata?.contentType) {
          resolvedType = metadata.contentType;
        } else if (data instanceof Blob && data.type !== '') {
          resolvedType = data.type;
        }
        let raw: Uint8Array;
        if (data instanceof Blob) {
          raw = new Uint8Array(await data.arrayBuffer());
        } else {
          raw = new Uint8Array(data);
        }
        return {
          uploadContentType: resolvedType,
          storedContentType: resolvedType,
          size: raw.byteLength,
          readBytes: Array.from(raw),
        };
      },
    };

    const observed = await observeUploadBytesContentTypePrecedence(subject);
    expect(observed).toEqual({
      expectedBytes: [0x52, 0x49, 0x46, 0x46],
      emptyBlobNoHint: {
        uploadContentType: 'application/octet-stream',
        storedContentType: 'application/octet-stream',
        size: 4,
        readBytes: [0x52, 0x49, 0x46, 0x46],
      },
      typedBlobNoHint: {
        uploadContentType: 'image/png',
        storedContentType: 'image/png',
        size: 4,
        readBytes: [0x52, 0x49, 0x46, 0x46],
      },
      typedBlobCallerOverride: {
        uploadContentType: 'application/pdf',
        storedContentType: 'application/pdf',
        size: 4,
        readBytes: [0x52, 0x49, 0x46, 0x46],
      },
      emptyBlobCallerHint: {
        uploadContentType: 'audio/wav',
        storedContentType: 'audio/wav',
        size: 4,
        readBytes: [0x52, 0x49, 0x46, 0x46],
      },
      uint8NoHint: {
        uploadContentType: 'application/octet-stream',
        storedContentType: 'application/octet-stream',
        size: 4,
        readBytes: [0x52, 0x49, 0x46, 0x46],
      },
    });
  });

  it('storage-uploadbytes-custom-metadata and storage-uploadbytes-overwrite-generations observe metadata round-trip, overwrite replacement, and increasing generations', async () => {
    expect(uploadCustomMetadataProbe.rig).toBe('sdk-probes');
    expect(uploadOverwriteProbe.rig).toBe('sdk-probes');

    const customSubject: StorageUploadCustomMetadataSubject = {
      async uploadAndReadCustomMetadata(_subpath, customMetadata) {
        if (customMetadata === undefined) {
          return {
            uploadHasCustomMetadataProperty: false,
            uploadCustomMetadata: null,
            getMetadataCustomMetadata: null,
          };
        }
        return {
          uploadHasCustomMetadataProperty: true,
          uploadCustomMetadata: { ...customMetadata },
          getMetadataCustomMetadata: { ...customMetadata },
        };
      },
    };
    const customObserved = await observeUploadBytesCustomMetadata(customSubject);
    expect(customObserved).toEqual({
      withoutCustomMetadata: {
        uploadHasCustomMetadataProperty: false,
        uploadCustomMetadata: null,
        getMetadataCustomMetadata: null,
      },
      withCustomMetadata: {
        uploadHasCustomMetadataProperty: true,
        uploadCustomMetadata: {
          owner: 'user-1',
          label: 'alpha release',
          emptyValue: '',
        },
        getMetadataCustomMetadata: {
          owner: 'user-1',
          label: 'alpha release',
          emptyValue: '',
        },
      },
    });

    let currentBytes: number[] = [];
    let currentMeta = {
      size: 0,
      contentType: null as string | null,
      customMetadata: null as Record<string, string> | null,
      generation: '0',
      metageneration: '1',
    };
    let nextGen = 1793000000000000n;

    const overwriteSubject: StorageUploadOverwriteSubject = {
      async uploadVersion(bytes, metadata) {
        nextGen += 100n;
        currentBytes = Array.from(bytes);
        currentMeta = {
          size: bytes.byteLength,
          contentType: metadata.contentType,
          customMetadata: { ...metadata.customMetadata },
          generation: String(nextGen),
          metageneration: '1',
        };
        return { ...currentMeta };
      },
      async readCurrentBytes() {
        return [...currentBytes];
      },
      async readCurrentMetadata() {
        return { ...currentMeta };
      },
    };

    const overwriteObserved = await observeUploadBytesOverwriteGenerations(overwriteSubject);
    expect(overwriteObserved).toEqual({
      firstUpload: {
        size: 7,
        contentType: 'application/octet-stream',
        customMetadata: { revision: 'first', extra: 'removed-on-overwrite' },
        generationType: 'string',
        generationIsDecimalDigits: true,
        metagenerationType: 'string',
        metageneration: '1',
      },
      secondUpload: {
        size: 3,
        contentType: 'application/json',
        customMetadata: { revision: 'second' },
        generationType: 'string',
        generationIsDecimalDigits: true,
        metagenerationType: 'string',
        metageneration: '1',
      },
      generationChanged: true,
      generationStrictlyIncreased: true,
      afterOverwriteReadBytes: [10, 20, 30],
      afterOverwriteGetMetadata: {
        size: 3,
        contentType: 'application/json',
        customMetadata: { revision: 'second' },
        generationMatchesSecondUpload: true,
        metageneration: '1',
      },
    });
  });

  it('links all 5 uploadBytes probes and observations to storage#24..35, #38, #118 with zero registry validation problems', async () => {
    const sdkProbes = await loadModularProbes('sdk-probes');
    const sdkIds = sdkProbes.map((item) => item.id);
    expect(sdkIds).toContain('storage-uploadbytes-payload-types');
    expect(sdkIds).toContain('storage-uploadbytes-contenttype-precedence');
    expect(sdkIds).toContain('storage-uploadbytes-custom-metadata');
    expect(sdkIds).toContain('storage-uploadbytes-overwrite-generations');

    const currentObservations = loadObservations();
    const obsByName = new Map(currentObservations.map((obs) => [obs.name, obs]));

    const expectedLinks = [
      {
        name: 'client-storage-uploadbytes-root-ref',
        probe: uploadRootRefProbe,
        rowIds: ['storage#31'],
      },
      {
        name: 'storage-uploadbytes-payload-types',
        probe: uploadPayloadTypesProbe,
        rowIds: ['storage#24', 'storage#25', 'storage#26', 'storage#32', 'storage#33', 'storage#34'],
      },
      {
        name: 'storage-uploadbytes-contenttype-precedence',
        probe: uploadContentTypeProbe,
        rowIds: ['storage#27', 'storage#28', 'storage#30'],
      },
      {
        name: 'storage-uploadbytes-custom-metadata',
        probe: uploadCustomMetadataProbe,
        rowIds: ['storage#29'],
      },
      {
        name: 'storage-uploadbytes-overwrite-generations',
        probe: uploadOverwriteProbe,
        rowIds: ['storage#35', 'storage#38', 'storage#118'],
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
