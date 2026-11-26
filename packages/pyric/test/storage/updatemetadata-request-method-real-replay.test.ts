/**
 * Real-resource replay: Storage `updateMetadata` vs upload overwrite `request.method` (#1884).
 *
 * `storage-updatemetadata-request-method.json` records production verdicts for a
 * metadata-only `updateMetadata(ref, patch)` over a seeded 5-byte object under
 * `allow write` gated by `request.method == 'create'` vs `request.method == 'update'`
 * and under granular `allow create` vs `allow update`.
 * `stdlib-realstorage-request-resource-fields.json` records production verdicts
 * (`overwrite/verb-create` ALLOW, `overwrite/verb-update` DENY) for a 6-byte
 * upload over a seeded 5-byte object.
 *
 * This suite replays both committed observations against the Storage sandbox
 * (`updateMetadata` and `uploadBytes`), proving metadata-only updates bind `update`
 * while byte overwrites over an existing object bind `create`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  deleteObject,
  getMetadata,
  getStorageSandbox,
  ref,
  updateMetadata,
  uploadBytes,
} from '../../src/storage/index.js';
import {
  captureUpdateMetadataAttempt,
  observeStorageUpdateMetadataRequestMethod,
  summarizeStoredMetadata,
  updateMetadataMethodOracleTarget,
  updateMetadataMethodPaths,
} from '../../../conformance/probes/storage/storage-updatemetadata-request-method.ts';
import {
  OBSERVATION_NAME as OVERWRITE_OBSERVATION_NAME,
  PROBE_PAYLOAD,
  PROBE_REPLACEMENT,
} from '../../../conformance/src/storage-request-resource-probes.ts';

const UPDATE_METHOD_OBSERVATION = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'storage',
  'storage-updatemetadata-request-method.json',
);

const OVERWRITE_OBSERVATION = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'storage-rules',
  `${OVERWRITE_OBSERVATION_NAME}.json`,
);

const REPLAY_UIDS = {
  seedUid: 'pyric-seed-client',
  updateMethodUid: 'pyric-update-method-client',
  createMethodUid: 'pyric-create-method-client',
} as const;

interface CapturedUpdateMethodObservation {
  behavior: Record<string, unknown>;
}

interface CapturedOverwriteObservation {
  behavior: {
    overwrite: Record<string, 'ALLOW' | 'DENY'>;
  };
}

function readUpdateMethodObservation(): CapturedUpdateMethodObservation {
  return JSON.parse(readFileSync(UPDATE_METHOD_OBSERVATION, 'utf8')) as CapturedUpdateMethodObservation;
}

function readOverwriteObservation(): CapturedOverwriteObservation {
  return JSON.parse(readFileSync(OVERWRITE_OBSERVATION, 'utf8')) as CapturedOverwriteObservation;
}

async function cleanupObject(storage: ReturnType<typeof getStorageSandbox>, path: string): Promise<void> {
  try {
    await deleteObject(ref(storage, path));
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code !== 'storage/object-not-found') {
      throw err;
    }
  }
}

describe('storage-updatemetadata-request-method: sandbox writes replay production verb bindings (#1884)', () => {
  it('matches production updateMetadata verdicts (update) and binds create on byte overwrites over the same stored objects', async () => {
    const capturedUpdate = readUpdateMethodObservation();
    const capturedOverwrite = readOverwriteObservation();
    const runId = 'replay_1884';
    const bucketId = 'demo-pyric.appspot.com';
    const paths = updateMetadataMethodPaths(runId);
    const rules = updateMetadataMethodOracleTarget(bucketId, runId, REPLAY_UIDS).freshRules;

    const sandbox = initializeSandbox({});
    const dbName = `pyric-1884-replay-${Math.random().toString(36).slice(2, 10)}`;
    const seedStorage = getStorageSandbox(
      sandbox.withAuth({ uid: REPLAY_UIDS.seedUid }),
      { dbName, bucket: bucketId, rules },
    );
    const updateMethodStorage = getStorageSandbox(
      sandbox.withAuth({ uid: REPLAY_UIDS.updateMethodUid }),
      { dbName, bucket: bucketId, rules },
    );
    const createMethodStorage = getStorageSandbox(
      sandbox.withAuth({ uid: REPLAY_UIDS.createMethodUid }),
      { dbName, bucket: bucketId, rules },
    );

    try {
      const observed = await observeStorageUpdateMetadataRequestMethod({
        async seedObjects() {
          const seedMeta = {
            contentType: 'text/plain',
            customMetadata: { stage: 'seed' },
          };
          await uploadBytes(ref(seedStorage, paths.deniedControlPath), PROBE_PAYLOAD, seedMeta);
          const targetUpload = await uploadBytes(ref(seedStorage, paths.targetPath), PROBE_PAYLOAD, seedMeta);
          const granularUpload = await uploadBytes(ref(seedStorage, paths.granularPath), PROBE_PAYLOAD, seedMeta);
          return {
            targetInitial: summarizeStoredMetadata(targetUpload.metadata),
            granularInitial: summarizeStoredMetadata(granularUpload.metadata),
          };
        },
        attemptDeniedControlCreateClient() {
          return captureUpdateMetadataAttempt(() =>
            updateMetadata(ref(createMethodStorage, paths.deniedControlPath), {
              customMetadata: { stage: 'denied-create' },
            }),
          );
        },
        attemptDeniedControlUpdateClient() {
          return captureUpdateMetadataAttempt(() =>
            updateMetadata(ref(updateMethodStorage, paths.deniedControlPath), {
              customMetadata: { stage: 'denied-update' },
            }),
          );
        },
        attemptTargetWhenMethodEqualsCreate() {
          return captureUpdateMetadataAttempt(() =>
            updateMetadata(ref(createMethodStorage, paths.targetPath), {
              customMetadata: { stage: 'create-arm' },
            }),
          );
        },
        async readTargetMetadata() {
          return summarizeStoredMetadata(await getMetadata(ref(seedStorage, paths.targetPath)));
        },
        attemptTargetWhenMethodEqualsUpdate() {
          return captureUpdateMetadataAttempt(() =>
            updateMetadata(ref(updateMethodStorage, paths.targetPath), {
              customMetadata: { stage: 'update-arm' },
            }),
          );
        },
        attemptGranularAllowCreateVerb() {
          return captureUpdateMetadataAttempt(() =>
            updateMetadata(ref(createMethodStorage, paths.granularPath), {
              customMetadata: { stage: 'create-verb' },
            }),
          );
        },
        async readGranularMetadata() {
          return summarizeStoredMetadata(await getMetadata(ref(seedStorage, paths.granularPath)));
        },
        attemptGranularAllowUpdateVerb() {
          return captureUpdateMetadataAttempt(() =>
            updateMetadata(ref(updateMethodStorage, paths.granularPath), {
              customMetadata: { stage: 'update-verb' },
            }),
          );
        },
      });

      expect(observed).toEqual(capturedUpdate.behavior);

      const overwriteMetadata = { contentType: 'text/plain', customMetadata: { stage: 'overwrite' } };
      const overwriteMethodUpdateArm = await captureUpdateMetadataAttempt(() =>
        uploadBytes(ref(updateMethodStorage, paths.targetPath), PROBE_REPLACEMENT, overwriteMetadata),
      );
      const overwriteMethodCreateArm = await captureUpdateMetadataAttempt(() =>
        uploadBytes(ref(createMethodStorage, paths.targetPath), PROBE_REPLACEMENT, overwriteMetadata),
      );
      expect(overwriteMethodUpdateArm.verdict).toBe(capturedOverwrite.behavior.overwrite['verb-update']);
      expect(overwriteMethodCreateArm.verdict).toBe(capturedOverwrite.behavior.overwrite['verb-create']);

      const overwriteGranularUpdateArm = await captureUpdateMetadataAttempt(() =>
        uploadBytes(ref(updateMethodStorage, paths.granularPath), PROBE_REPLACEMENT, overwriteMetadata),
      );
      const overwriteGranularCreateArm = await captureUpdateMetadataAttempt(() =>
        uploadBytes(ref(createMethodStorage, paths.granularPath), PROBE_REPLACEMENT, overwriteMetadata),
      );
      expect(overwriteGranularUpdateArm.verdict).toBe(capturedOverwrite.behavior.overwrite['verb-update']);
      expect(overwriteGranularCreateArm.verdict).toBe(capturedOverwrite.behavior.overwrite['verb-create']);
    } finally {
      await cleanupObject(seedStorage, paths.deniedControlPath);
      await cleanupObject(seedStorage, paths.targetPath);
      await cleanupObject(seedStorage, paths.granularPath);
    }
  });
});
