import { describe, expect, it } from 'bun:test';
import { allCompatibilityRows } from '../../registry/index.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import {
  observeStorageGetStorageAndMd5,
  probe as getStorageMd5Probe,
  type GetStorageMd5Subject,
} from '../../probes/storage/storage-getstorage-handle-and-md5.ts';
import {
  buildDeterministicResumablePayload,
  observeUploadBytesResumableLifecycle,
  probe as resumableProbe,
  RESUMABLE_PROBE_BYTE_LENGTH,
  type UploadBytesResumableProbeSubject,
} from '../../probes/storage/storage-uploadbytesresumable-progress-and-controls.ts';
import {
  observeUploadStringBase64UrlRoundtrip,
  probe as base64UrlProbe,
  type UploadStringBase64UrlSubject,
} from '../../probes/storage/storage-uploadstring-base64url-roundtrip.ts';
import {
  observeUpdateMetadataUndefinedAndNullClear,
  probe as updateMetadataUndefinedNullProbe,
  type ProjectedWritableMetadata,
  type UpdateMetadataUndefinedNullSubject,
} from '../../probes/storage/storage-updatemetadata-undefined-and-null-clear.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import { loadObservations } from '../../src/ledger.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const SLICE11_PROBES = [
  { name: 'storage-getstorage-handle-and-md5', probe: getStorageMd5Probe },
  { name: 'storage-uploadstring-base64url-roundtrip', probe: base64UrlProbe },
  { name: 'storage-uploadbytesresumable-progress-and-controls', probe: resumableProbe },
  {
    name: 'storage-updatemetadata-undefined-and-null-clear',
    probe: updateMetadataUndefinedNullProbe,
  },
] as const;

const SLICE11_PROBE_NAMES = SLICE11_PROBES.map((entry) => entry.name);

describe('staged storage probes for getStorage, base64url, uploadBytesResumable, updateMetadata null/undefined, and md5Hash (storage#3, #41, #47..50, #86, #91)', () => {
  it('registers all 4 probes under sdk-probes and tracks staged discovery via expectStagedUntilCaptured', () => {
    const probeFileNames = new Set(
      listProbeFiles()
        .filter((f) => f.surfaceDir === 'storage')
        .map((f) => f.name),
    );
    for (const entry of SLICE11_PROBES) {
      expect(probeFileNames.has(entry.name)).toBe(true);
      expect(entry.probe.rig).toBe('sdk-probes');
      expect(entry.probe.pendingRowLink).toBe(true);
      expect(entry.probe.matrixRow).toBe('');
      expect(entry.probe.rowIds).toEqual([]);
    }

    expectStagedUntilCaptured(SLICE11_PROBE_NAMES, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
    });
  });

  it('observeStorageGetStorageAndMd5 records handle identity, retry times, and matching upload/getMetadata MD5 digests', async () => {
    const subject: GetStorageMd5Subject = {
      async inspectHandlesAndRetryTimes() {
        return {
          sameAppIdentityStable: true,
          differentAppDistinctHandle: true,
          appPropertyMatches: true,
          defaultMaxOperationRetryTime: 120000,
          defaultMaxUploadRetryTime: 600000,
          updatedMaxOperationRetryTime: 45000,
          updatedMaxUploadRetryTime: 180000,
        };
      },
      async uploadAndReadMd5(_subpath, bytes) {
        let digest = 'CY9rzUYh03PK3k6DJie09g==';
        if (bytes.byteLength === 0) {
          digest = '1B2M2Y8AsgTpgAmY7PhCfg==';
        }
        return {
          uploadMd5: digest,
          getMetadataMd5: digest,
          readBackBytes: [...bytes],
        };
      },
    };

    const out = await observeStorageGetStorageAndMd5(subject);
    expect(out).toEqual({
      sameAppIdentityStable: true,
      differentAppDistinctHandle: true,
      appPropertyMatches: true,
      defaultMaxOperationRetryTime: 120000,
      defaultMaxUploadRetryTime: 600000,
      updatedMaxOperationRetryTime: 45000,
      updatedMaxUploadRetryTime: 180000,
      emptyPayloadMd5OnUpload: '1B2M2Y8AsgTpgAmY7PhCfg==',
      emptyPayloadMd5OnGetMetadata: '1B2M2Y8AsgTpgAmY7PhCfg==',
      emptyPayloadMd5MatchesUploadAndGet: true,
      fourBytePayloadMd5OnUpload: 'CY9rzUYh03PK3k6DJie09g==',
      fourBytePayloadMd5OnGetMetadata: 'CY9rzUYh03PK3k6DJie09g==',
      fourBytePayloadMd5MatchesUploadAndGet: true,
      roundtripBytes: [1, 2, 3, 4],
    });
  });

  it('observeUploadStringBase64UrlRoundtrip and observeUploadBytesResumableLifecycle record deterministic invariants', async () => {
    const base64UrlSubject: UploadStringBase64UrlSubject = {
      async uploadBase64UrlAndRead(_subpath, encoded) {
        let decoded = [251, 255];
        if (encoded === '-_8BAg') {
          decoded = [251, 255, 1, 2];
        }
        return {
          contentType: 'application/octet-stream',
          size: decoded.length,
          bytes: decoded,
        };
      },
      async callUnknownFormat() {
        return {
          threw: true,
          threwSynchronously: true,
          code: 'storage/unknown',
          errorName: 'FirebaseError',
          isFirebaseError: true,
        };
      },
    };

    const base64UrlOut = await observeUploadStringBase64UrlRoundtrip(base64UrlSubject);
    expect(base64UrlOut).toEqual({
      unpaddedUrlSafe: {
        contentType: 'application/octet-stream',
        size: 4,
        bytes: [251, 255, 1, 2],
      },
      paddedUrlSafe: {
        contentType: 'application/octet-stream',
        size: 2,
        bytes: [251, 255],
      },
      unknownFormat: {
        threw: true,
        threwSynchronously: true,
        code: 'storage/unknown',
        errorName: 'FirebaseError',
        isFirebaseError: true,
      },
    });

    const samplePayload = buildDeterministicResumablePayload();
    expect(samplePayload.byteLength).toBe(RESUMABLE_PROBE_BYTE_LENGTH);
    expect(samplePayload.byteLength).toBeGreaterThan(256 * 1024);

    const resumableSubject: UploadBytesResumableProbeSubject = {
      async runProgressToCompletion(_subpath, payload) {
        return {
          hasPauseMethod: true,
          hasResumeMethod: true,
          hasCancelMethod: true,
          hasOnMethod: true,
          unsubscribeIsFunction: true,
          sawRunningSnapshot: true,
          bytesMonotonicNonDecreasing: true,
          allTotalBytesMatchPayload: true,
          completeCallbackFiredOnce: true,
          errorCallbackFired: false,
          finalSnapshotState: 'success',
          finalBytesTransferred: payload.byteLength,
          finalTotalBytes: payload.byteLength,
          metadataContentType: 'application/octet-stream',
          storedByteLength: payload.byteLength,
          firstFourBytes: [...payload.slice(0, 4)],
          lastFourBytes: [...payload.slice(payload.byteLength - 4)],
        };
      },
      async runPauseAndResume(_subpath, payload) {
        return {
          pauseReturnedTrue: true,
          sawPausedSnapshot: true,
          pauseWhilePausedReturnedFalse: true,
          resumeReturnedTrue: true,
          finalSnapshotState: 'success',
          storedByteLength: payload.byteLength,
        };
      },
      async runCancel() {
        return {
          cancelReturnedTrue: true,
          taskRejected: true,
          taskErrorCode: 'storage/canceled',
          taskErrorIsFirebaseError: true,
          observerErrorCode: 'storage/canceled',
          completeCalledOnCancel: false,
          postCancelGetMetadataCode: 'storage/object-not-found',
        };
      },
    };

    const resumableOut = await observeUploadBytesResumableLifecycle(resumableSubject);
    expect(resumableOut).toMatchObject({
      payloadByteLength: RESUMABLE_PROBE_BYTE_LENGTH,
      progressAndComplete: {
        finalSnapshotState: 'success',
        completeCallbackFiredOnce: true,
      },
      pauseAndResume: {
        sawPausedSnapshot: true,
        resumeReturnedTrue: true,
      },
      cancelFlow: {
        taskErrorCode: 'storage/canceled',
        postCancelGetMetadataCode: 'storage/object-not-found',
      },
    });
  });

  it('observeUpdateMetadataUndefinedAndNullClear records undefined preservation vs null clearing and validates registry', async () => {
    let state: ProjectedWritableMetadata = {
      contentType: 'text/plain',
      cacheControl: null,
      contentDisposition: null,
      contentLanguage: null,
      customMetadata: null,
    };

    const metadataSubject: UpdateMetadataUndefinedNullSubject = {
      async seedWithAllWritableFields() {
        state = {
          contentType: 'text/plain',
          cacheControl: 'public, max-age=60',
          contentDisposition: 'inline',
          contentLanguage: 'en',
          customMetadata: { keep: 'yes', drop: 'soon' },
        };
        return { ...state };
      },
      async patchMetadata(_subpath, patch) {
        if ('cacheControl' in patch) {
          if (patch.cacheControl === null) {
            state.cacheControl = null;
          } else if (typeof patch.cacheControl === 'string') {
            state.cacheControl = patch.cacheControl;
          }
        }
        if ('contentDisposition' in patch) {
          if (patch.contentDisposition === null) {
            state.contentDisposition = null;
          } else if (typeof patch.contentDisposition === 'string') {
            state.contentDisposition = patch.contentDisposition;
          }
        }
        if (typeof patch.contentLanguage === 'string') {
          state.contentLanguage = patch.contentLanguage;
        }
        if ('customMetadata' in patch) {
          if (patch.customMetadata === null) {
            state.customMetadata = null;
          } else if (patch.customMetadata !== undefined) {
            const incoming = patch.customMetadata as Record<string, string | null>;
            const nextMap: Record<string, string> = { ...(state.customMetadata ?? {}) };
            for (const [k, v] of Object.entries(incoming)) {
              if (v === null) {
                delete nextMap[k];
              } else {
                nextMap[k] = v;
              }
            }
            state.customMetadata = nextMap;
          }
        }
        return { ...state };
      },
      async readMetadata() {
        return { ...state };
      },
    };

    const observed = await observeUpdateMetadataUndefinedAndNullClear(metadataSubject);
    expect(observed).toMatchObject({
      afterUndefinedFields: {
        cacheControl: 'public, max-age=60',
        contentDisposition: 'inline',
        contentLanguage: 'fr',
        customMetadata: { keep: 'yes', drop: 'soon' },
      },
      afterNullScalarAndKeyClear: {
        cacheControl: null,
        contentDisposition: null,
        contentLanguage: 'fr',
        customMetadata: { keep: 'yes' },
      },
      afterNullCustomMetadataMap: {
        customMetadata: null,
      },
    });

    const rigManifests = await loadRigManifests();
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
      rigManifests,
      probeFiles: listProbeFiles(),
      rulesStorageScenarioIds: ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id),
    });
    expect(problems).toEqual([]);
  });
});
