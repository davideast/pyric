import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  deleteObject,
  getMetadata,
  getStorageSandbox,
  ref,
  updateMetadata,
  uploadBytes,
} from '../../../pyric/src/storage/index.js';
import { evaluateStorageRules } from '../../../rules/src/storage/rules-evaluator.ts';
import { parseStorageRules } from '../../../rules/src/storage/rules.ts';
import { normalizeStoragePath } from '../../../rules/src/test/spec.ts';
import { planCaptureRun } from '../../../../scripts/ci/oracle-capture-plan.ts';
import {
  captureUpdateMetadataAttempt,
  observeStorageUpdateMetadataRequestMethod,
  probe as updateMetadataMethodProbe,
  runWithMethodProbeTeardown,
  summarizeStoredMetadata,
  updateMetadataMethodOracleTarget,
  updateMetadataMethodPaths,
  type StorageUpdateMetadataMethodSubject,
} from '../../probes/storage/storage-updatemetadata-request-method.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const OFFLINE_UIDS = {
  seedUid: 'pyric-seed-client',
  updateMethodUid: 'pyric-update-method-client',
  createMethodUid: 'pyric-create-method-client',
} as const;

describe('storage-updatemetadata-request-method staged live-bucket probe (#1884)', () => {
  it('runs end-to-end offline against pyric Storage sandbox and records current updateMetadata and coarse-write verdicts', async () => {
    const runId = 'offline_1884';
    const paths = updateMetadataMethodPaths(runId);
    const target = updateMetadataMethodOracleTarget('demo-pyric.appspot.com', runId, OFFLINE_UIDS);
    const rules = target.freshRules;

    const sandbox = initializeSandbox({});
    const dbName = `pyric-1884-offline-${Math.random().toString(36).slice(2, 10)}`;
    const seedStorage = getStorageSandbox(
      sandbox.withAuth({ uid: OFFLINE_UIDS.seedUid }),
      { dbName, rules },
    );
    const updateMethodStorage = getStorageSandbox(
      sandbox.withAuth({ uid: OFFLINE_UIDS.updateMethodUid }),
      { dbName, rules },
    );
    const createMethodStorage = getStorageSandbox(
      sandbox.withAuth({ uid: OFFLINE_UIDS.createMethodUid }),
      { dbName, rules },
    );

    const payload = new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]);

    try {
      const observed = await observeStorageUpdateMetadataRequestMethod({
        async seedObjects() {
          const seedMeta = {
            contentType: 'text/plain',
            customMetadata: { stage: 'seed' },
          };
          await uploadBytes(ref(seedStorage, paths.deniedControlPath), payload, seedMeta);
          const targetUpload = await uploadBytes(
            ref(seedStorage, paths.targetPath),
            payload,
            seedMeta,
          );
          const granularUpload = await uploadBytes(
            ref(seedStorage, paths.granularPath),
            payload,
            seedMeta,
          );
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

      // Pyric Storage SDK sandbox today binds request.method == 'update' on updateMetadata:
      expect(observed).toEqual({
        deniedControl: {
          createClient: {
            verdict: 'DENY',
            threw: true,
            code: 'storage/unauthorized',
          },
          updateClient: {
            verdict: 'DENY',
            threw: true,
            code: 'storage/unauthorized',
          },
        },
        sameObjectRequestMethod: {
          initialSize: 5,
          initialCustomMetadata: { stage: 'seed' },
          whenMethodEqualsCreate: {
            verdict: 'DENY',
            threw: true,
            code: 'storage/unauthorized',
          },
          afterCreateArmCustomMetadata: { stage: 'seed' },
          afterCreateArmMetagenerationChanged: false,
          whenMethodEqualsUpdate: {
            verdict: 'ALLOW',
            threw: false,
            code: null,
          },
          afterUpdateArmCustomMetadata: { stage: 'update-arm' },
          afterUpdateArmMetagenerationChanged: true,
        },
        sameObjectGranularVerb: {
          initialSize: 5,
          initialCustomMetadata: { stage: 'seed' },
          allowCreateVerb: {
            verdict: 'DENY',
            threw: true,
            code: 'storage/unauthorized',
          },
          afterAllowCreateVerbCustomMetadata: { stage: 'seed' },
          afterAllowCreateVerbMetagenerationChanged: false,
          allowUpdateVerb: {
            verdict: 'ALLOW',
            threw: false,
            code: null,
          },
          afterAllowUpdateVerbCustomMetadata: { stage: 'update-verb' },
          afterAllowUpdateVerbMetagenerationChanged: true,
        },
      });

      // Compare with evaluateStorageRules on the same ruleset for granular 'update' vs coarse 'write':
      const parsed = parseStorageRules(rules);
      const resourcePath = normalizeStoragePath(paths.targetPath, 'demo-pyric.appspot.com');
      const storedResource = { size: 5, contentType: 'text/plain', metadata: { stage: 'seed' } };
      const incomingResource = { size: 5, contentType: 'text/plain', metadata: { stage: 'next' } };

      const granularUpdateArm = evaluateStorageRules(parsed, {
        request: {
          auth: { uid: OFFLINE_UIDS.updateMethodUid },
          method: 'update',
          path: resourcePath,
          resource: incomingResource,
        },
        resource: storedResource,
      });
      const granularCreateArm = evaluateStorageRules(parsed, {
        request: {
          auth: { uid: OFFLINE_UIDS.createMethodUid },
          method: 'update',
          path: resourcePath,
          resource: incomingResource,
        },
        resource: storedResource,
      });
      expect(granularUpdateArm.allowed).toBe(true);
      expect(granularCreateArm.allowed).toBe(false);

      const coarseWriteUpdateArm = evaluateStorageRules(parsed, {
        request: {
          auth: { uid: OFFLINE_UIDS.updateMethodUid },
          method: 'write',
          path: resourcePath,
          resource: incomingResource,
        },
        resource: storedResource,
      });
      const coarseWriteCreateArm = evaluateStorageRules(parsed, {
        request: {
          auth: { uid: OFFLINE_UIDS.createMethodUid },
          method: 'write',
          path: resourcePath,
          resource: incomingResource,
        },
        resource: storedResource,
      });
      // Today impliedVerbs maps coarse 'write' with request.resource to ['create']:
      expect(coarseWriteUpdateArm.allowed).toBe(false);
      expect(coarseWriteCreateArm.allowed).toBe(true);
    } finally {
      await deleteObject(ref(seedStorage, paths.deniedControlPath)).catch(() => undefined);
      await deleteObject(ref(seedStorage, paths.targetPath)).catch(() => undefined);
      await deleteObject(ref(seedStorage, paths.granularPath)).catch(() => undefined);
    }
  });

  it('records whichever verdict production returns without asserting the answer in the probe', async () => {
    const allowOutcome = {
      verdict: 'ALLOW' as const,
      threw: false,
      code: null,
    };
    const denyOutcome = {
      verdict: 'DENY' as const,
      threw: true,
      code: 'storage/unauthorized',
    };
    const syntheticCreateWinsSubject: StorageUpdateMetadataMethodSubject = {
      async seedObjects() {
        return {
          targetInitial: { size: 5, metageneration: '1', customMetadata: { stage: 'seed' } },
          granularInitial: { size: 5, metageneration: '1', customMetadata: { stage: 'seed' } },
        };
      },
      async attemptDeniedControlCreateClient() {
        return denyOutcome;
      },
      async attemptDeniedControlUpdateClient() {
        return denyOutcome;
      },
      async attemptTargetWhenMethodEqualsCreate() {
        return allowOutcome;
      },
      async readTargetMetadata() {
        return { size: 5, metageneration: '2', customMetadata: { stage: 'create-arm' } };
      },
      async attemptTargetWhenMethodEqualsUpdate() {
        return denyOutcome;
      },
      async attemptGranularAllowCreateVerb() {
        return allowOutcome;
      },
      async readGranularMetadata() {
        return { size: 5, metageneration: '2', customMetadata: { stage: 'create-verb' } };
      },
      async attemptGranularAllowUpdateVerb() {
        return denyOutcome;
      },
    };

    const recorded = await observeStorageUpdateMetadataRequestMethod(syntheticCreateWinsSubject);
    expect(recorded.sameObjectRequestMethod).toMatchObject({
      whenMethodEqualsCreate: allowOutcome,
      whenMethodEqualsUpdate: denyOutcome,
      afterCreateArmMetagenerationChanged: true,
      afterUpdateArmMetagenerationChanged: false,
    });
  });

  it('cleans up signed-in users on partial sign-in or pre-deploy errors without ungranted Storage deletes', async () => {
    const partialSignedIn: string[] = [];
    const partialDeletedUsers: string[] = [];
    let partialObjectsDeleted = false;

    await expect(
      runWithMethodProbeTeardown({
        async signInAll() {
          partialSignedIn.push(OFFLINE_UIDS.seedUid);
          throw new Error('auth/too-many-requests on second client');
        },
        async deployRules() {},
        async runBody() {
          return 'unreachable';
        },
        async deleteObjects() {
          partialObjectsDeleted = true;
        },
        async deleteSignedInUsers() {
          partialDeletedUsers.push(...partialSignedIn);
        },
      }),
    ).rejects.toThrow('auth/too-many-requests on second client');
    expect(partialObjectsDeleted).toBe(false);
    expect(partialDeletedUsers).toEqual([OFFLINE_UIDS.seedUid]);

    const deploySignedIn: string[] = [];
    const deployDeletedUsers: string[] = [];
    let deployObjectsDeleted = false;

    await expect(
      runWithMethodProbeTeardown({
        async signInAll() {
          deploySignedIn.push(
            OFFLINE_UIDS.seedUid,
            OFFLINE_UIDS.updateMethodUid,
            OFFLINE_UIDS.createMethodUid,
          );
          return OFFLINE_UIDS;
        },
        async deployRules() {
          throw new Error('rules release patch failed');
        },
        async runBody() {
          return 'unreachable';
        },
        async deleteObjects() {
          deployObjectsDeleted = true;
        },
        async deleteSignedInUsers() {
          deployDeletedUsers.push(...deploySignedIn);
        },
      }),
    ).rejects.toThrow('rules release patch failed');
    expect(deployObjectsDeleted).toBe(false);
    expect(deployDeletedUsers).toEqual([
      OFFLINE_UIDS.seedUid,
      OFFLINE_UIDS.updateMethodUid,
      OFFLINE_UIDS.createMethodUid,
    ]);

    const postDeployEvents: string[] = [];
    await expect(
      runWithMethodProbeTeardown({
        async signInAll() {
          return OFFLINE_UIDS;
        },
        async deployRules() {
          postDeployEvents.push('deployed');
        },
        async runBody() {
          throw new Error('canary timeout');
        },
        async deleteObjects() {
          postDeployEvents.push('deleteObjects');
        },
        async deleteSignedInUsers() {
          postDeployEvents.push('deleteSignedInUsers');
        },
      }),
    ).rejects.toThrow('canary timeout');
    expect(postDeployEvents).toEqual(['deployed', 'deleteObjects', 'deleteSignedInUsers']);
  });

  it('registers as a pendingRowLink sdk-probes target routed to the capture-write WIF identity', async () => {
    expect(updateMetadataMethodProbe.rig).toBe('sdk-probes');
    expect(updateMetadataMethodProbe.pendingRowLink).toBe(true);
    expect(updateMetadataMethodProbe.rowIds).toEqual([]);
    expect(updateMetadataMethodProbe.matrixRow).toBe('');

    expectStagedUntilCaptured('storage-updatemetadata-request-method', {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
    });

    const plan = await planCaptureRun(
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        CAPTURE_WIF_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/p/providers/gh',
        CAPTURE_SA_EMAIL: 'capture-sa@example.iam.gserviceaccount.com',
        CAPTURE_RUNNER_OS: 'ubuntu-latest',
      },
      {
        stagedTargets: [
          {
            rig: 'sdk-probes',
            observationName: 'storage-updatemetadata-request-method',
            filterFlag: '--probe',
            filterValue: 'storage-updatemetadata-request-method',
          },
        ],
        pendingPrefixRigs: [],
      },
    );
    expect(plan.shouldRun).toBe(true);
    expect(plan.needsParityWif).toBe(false);
    expect(plan.needsCaptureWif).toBe(true);
    expect(plan.invocations).toEqual([
      {
        rig: 'sdk-probes',
        script: 'packages/conformance/src/sdk-probes.ts',
        args: ['--write', '--probe', 'storage-updatemetadata-request-method'],
        wifTier: 'capture-write',
      },
    ]);
  });
});
