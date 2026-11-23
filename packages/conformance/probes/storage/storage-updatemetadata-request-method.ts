import type { FirebaseOptions } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount, oracleAccessToken } from '../../src/oracle-credential.ts';
import {
  OracleRulesSession,
  runWithOracleRulesRestored,
  type OracleRulesTarget,
} from '../../src/oracle-rules-session.ts';
import { installOracleSignalRestoreGuard } from '../../src/oracle-signal-restore.ts';
import { resolveProbeWebConfig } from '../../src/sdk-probe-runtime.ts';
import { extractObservedErrorDetails, resolveProbeStorageBucket } from '../../src/storage-probe-session.ts';

const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';
const SAFE_UID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SEED_BYTES = new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]);

export interface UpdateMetadataMethodUids {
  readonly seedUid: string;
  readonly updateMethodUid: string;
  readonly createMethodUid: string;
}

export interface StorageRuleVerdictOutcome {
  verdict: 'ALLOW' | 'DENY';
  threw: boolean;
  code: string | null;
}

export interface StoredMetadataSummary {
  size: number;
  metageneration: string;
  customMetadata: Record<string, string> | null;
}

export interface StorageUpdateMetadataMethodSubject {
  seedObjects(): Promise<{
    targetInitial: StoredMetadataSummary;
    granularInitial: StoredMetadataSummary;
  }>;
  attemptDeniedControlCreateClient(): Promise<StorageRuleVerdictOutcome>;
  attemptDeniedControlUpdateClient(): Promise<StorageRuleVerdictOutcome>;
  attemptTargetWhenMethodEqualsCreate(): Promise<StorageRuleVerdictOutcome>;
  readTargetMetadata(): Promise<StoredMetadataSummary>;
  attemptTargetWhenMethodEqualsUpdate(): Promise<StorageRuleVerdictOutcome>;
  attemptGranularAllowCreateVerb(): Promise<StorageRuleVerdictOutcome>;
  readGranularMetadata(): Promise<StoredMetadataSummary>;
  attemptGranularAllowUpdateVerb(): Promise<StorageRuleVerdictOutcome>;
}

function assertSafeDistinctUids(uids: UpdateMetadataMethodUids): void {
  const entries: ReadonlyArray<readonly [string, string]> = [
    ['seedUid', uids.seedUid],
    ['updateMethodUid', uids.updateMethodUid],
    ['createMethodUid', uids.createMethodUid],
  ];
  for (const [label, value] of entries) {
    if (!SAFE_UID_PATTERN.test(value)) {
      throw new Error(`unsafe characters in ${label}`);
    }
  }
  const uniqueCount = new Set([uids.seedUid, uids.updateMethodUid, uids.createMethodUid]).size;
  if (uniqueCount !== 3) {
    throw new Error('expected three distinct client uids for seed, update, and create arms');
  }
}

export function updateMetadataMethodPaths(runId: string): {
  prefix: string;
  deniedControlPath: string;
  targetPath: string;
  granularPath: string;
  canaryPath(role: 'seed' | 'update' | 'create'): string;
} {
  if (!SAFE_UID_PATTERN.test(runId)) {
    throw new Error('unsafe characters in runId');
  }
  const prefix = `pyric_oracle_method_${runId}`;
  return {
    prefix,
    deniedControlPath: `${prefix}/denied_control.bin`,
    targetPath: `${prefix}/target.bin`,
    granularPath: `${prefix}/granular.bin`,
    canaryPath(role) {
      return `${prefix}/canary/${role}/ready.bin`;
    },
  };
}

/**
 * Builds the scoped Storage rules target for #1884.
 *
 * Uses top-level prefix `pyric_oracle_method_<runId>` (never nested under
 * `pyric_oracle/<run>/...`) so an existing harness wildcard cannot grant write
 * access. On `target.bin`, `createMethodUid` is allowed ONLY when
 * `request.method == 'create'` and `updateMethodUid` is allowed ONLY when
 * `request.method == 'update'`, testing both alternatives on the exact same
 * stored object. `granular.bin` pairs `allow create` and `allow update` on the
 * same object, and `denied_control.bin` verifies ungranted writes deny.
 */
export function updateMetadataMethodOracleTarget(
  bucketId: string,
  runId: string,
  uids: UpdateMetadataMethodUids,
): OracleRulesTarget {
  assertSafeDistinctUids(uids);
  const paths = updateMetadataMethodPaths(runId);
  const marker = `@pyric/oracle/storage-updatemetadata-method/${runId}`;
  const scopedBlock = `    // ${marker}
    match /${paths.prefix}/canary/{role}/{id} {
      allow create, delete: if request.auth != null
        && (
          request.auth.uid == '${uids.seedUid}'
          || request.auth.uid == '${uids.updateMethodUid}'
          || request.auth.uid == '${uids.createMethodUid}'
        );
    }
    match /${paths.deniedControlPath} {
      allow get, create, delete: if request.auth != null && request.auth.uid == '${uids.seedUid}';
    }
    match /${paths.targetPath} {
      allow get, create, delete: if request.auth != null && request.auth.uid == '${uids.seedUid}';
      allow write: if request.auth != null
        && (
          (request.auth.uid == '${uids.updateMethodUid}' && request.method == 'update')
          || (request.auth.uid == '${uids.createMethodUid}' && request.method == 'create')
        );
    }
    match /${paths.granularPath} {
      allow get, create, delete: if request.auth != null && request.auth.uid == '${uids.seedUid}';
      allow update: if request.auth != null && request.auth.uid == '${uids.updateMethodUid}';
      allow create: if request.auth != null && request.auth.uid == '${uids.createMethodUid}';
    }`;
  return {
    service: 'Storage',
    release: `firebase.storage/${bucketId}`,
    rulesFileName: 'storage.rules',
    marker,
    freshRules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${scopedBlock}
  }
}
`,
    insertAfter: /(match\s+\/b\/\{bucket\}\/o\s*\{)/,
    insertAfterDescription: '`match /b/{bucket}/o`',
    block: `\n${scopedBlock}\n`,
  };
}

/**
 * Records ALLOW or DENY (`storage/unauthorized`) without asserting which arm
 * wins; rethrows any non-authorization failure so transport errors never
 * masquerade as security-rules denials.
 */
export async function captureUpdateMetadataAttempt(
  runOp: () => Promise<unknown>,
): Promise<StorageRuleVerdictOutcome> {
  try {
    await runOp();
    return {
      verdict: 'ALLOW',
      threw: false,
      code: null,
    };
  } catch (err) {
    const details = extractObservedErrorDetails(err);
    if (details.code !== 'storage/unauthorized') {
      throw err;
    }
    return {
      verdict: 'DENY',
      threw: true,
      code: details.code,
    };
  }
}

export function summarizeStoredMetadata(meta: {
  size: number;
  metageneration: string;
  customMetadata?: Record<string, string>;
}): StoredMetadataSummary {
  let customMetadata: Record<string, string> | null = null;
  if (meta.customMetadata !== undefined) {
    customMetadata = meta.customMetadata;
  }
  return {
    size: meta.size,
    metageneration: meta.metageneration,
    customMetadata,
  };
}

interface MethodProbeTeardownCallbacks<T> {
  signInAll(): Promise<UpdateMetadataMethodUids>;
  deployRules(uids: UpdateMetadataMethodUids): Promise<void>;
  runBody(): Promise<T>;
  deleteObjects(): Promise<void>;
  deleteSignedInUsers(): Promise<void>;
}

/**
 * Ensures any signed-in temporary Firebase Auth users are deleted even if a
 * later sign-in or `session.deploy(...)` fails before Storage rules activate,
 * while running Storage object cleanup only after `deployRules` succeeds.
 */
export async function runWithMethodProbeTeardown<T>(
  callbacks: MethodProbeTeardownCallbacks<T>,
): Promise<T> {
  let rulesDeployed = false;
  try {
    const uids = await callbacks.signInAll();
    await callbacks.deployRules(uids);
    rulesDeployed = true;
    return await callbacks.runBody();
  } finally {
    if (rulesDeployed) {
      await callbacks.deleteObjects();
    }
    await callbacks.deleteSignedInUsers();
  }
}

export async function observeStorageUpdateMetadataRequestMethod(
  subject: StorageUpdateMetadataMethodSubject,
): Promise<Record<string, unknown>> {
  const seeded = await subject.seedObjects();

  const deniedControlCreateClient = await subject.attemptDeniedControlCreateClient();
  const deniedControlUpdateClient = await subject.attemptDeniedControlUpdateClient();

  const whenMethodEqualsCreate = await subject.attemptTargetWhenMethodEqualsCreate();
  const afterCreateArm = await subject.readTargetMetadata();

  const whenMethodEqualsUpdate = await subject.attemptTargetWhenMethodEqualsUpdate();
  const afterUpdateArm = await subject.readTargetMetadata();

  const allowCreateVerb = await subject.attemptGranularAllowCreateVerb();
  const afterAllowCreateVerb = await subject.readGranularMetadata();

  const allowUpdateVerb = await subject.attemptGranularAllowUpdateVerb();
  const afterAllowUpdateVerb = await subject.readGranularMetadata();

  return {
    deniedControl: {
      createClient: deniedControlCreateClient,
      updateClient: deniedControlUpdateClient,
    },
    sameObjectRequestMethod: {
      initialSize: seeded.targetInitial.size,
      initialCustomMetadata: seeded.targetInitial.customMetadata,
      whenMethodEqualsCreate,
      afterCreateArmCustomMetadata: afterCreateArm.customMetadata,
      afterCreateArmMetagenerationChanged:
        afterCreateArm.metageneration !== seeded.targetInitial.metageneration,
      whenMethodEqualsUpdate,
      afterUpdateArmCustomMetadata: afterUpdateArm.customMetadata,
      afterUpdateArmMetagenerationChanged:
        afterUpdateArm.metageneration !== afterCreateArm.metageneration,
    },
    sameObjectGranularVerb: {
      initialSize: seeded.granularInitial.size,
      initialCustomMetadata: seeded.granularInitial.customMetadata,
      allowCreateVerb,
      afterAllowCreateVerbCustomMetadata: afterAllowCreateVerb.customMetadata,
      afterAllowCreateVerbMetagenerationChanged:
        afterAllowCreateVerb.metageneration !== seeded.granularInitial.metageneration,
      allowUpdateVerb,
      afterAllowUpdateVerbCustomMetadata: afterAllowUpdateVerb.customMetadata,
      afterAllowUpdateVerbMetagenerationChanged:
        afterAllowUpdateVerb.metageneration !== afterAllowCreateVerb.metageneration,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  description:
    'firebase/storage metadata-only updateMetadata(ref, patch) security-rules request.method binding (#1884): records production ALLOW/DENY verdicts on the same seeded object under allow write gated by request.method == "create" versus request.method == "update", alongside granular allow create versus allow update.',
  async observe() {
    const [
      { deleteApp, initializeApp },
      { deleteUser, getAuth },
      storageSdk,
      { signInOracleClientAuth },
    ] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/storage'),
      import('../../src/oracle-run-auth-session.ts'),
    ]);

    const sa = await loadOracleServiceAccount();
    const webConfig = await resolveProbeWebConfig(sa);
    const storageBucket = resolveProbeStorageBucket(webConfig);
    const runId = `st_method_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const paths = updateMetadataMethodPaths(runId);

    const session = new OracleRulesSession({
      projectId: sa.project_id,
      accessToken: () => oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE),
    });
    const detachSignals = installOracleSignalRestoreGuard('[sdk-probes]', () =>
      session.restoreAll(),
    );

    const appOptions: FirebaseOptions = {
      ...(webConfig as FirebaseOptions),
      storageBucket,
    };
    const seedApp = initializeApp(appOptions, `sdk-probe-st-method-seed-${runId}`);
    const updateMethodApp = initializeApp(appOptions, `sdk-probe-st-method-update-${runId}`);
    const createMethodApp = initializeApp(appOptions, `sdk-probe-st-method-create-${runId}`);

    const seedAuth = getAuth(seedApp);
    const updateMethodAuth = getAuth(updateMethodApp);
    const createMethodAuth = getAuth(createMethodApp);

    const seedStorage = storageSdk.getStorage(seedApp);
    const updateMethodStorage = storageSdk.getStorage(updateMethodApp);
    const createMethodStorage = storageSdk.getStorage(createMethodApp);

    const cleanupRefs = [
      storageSdk.ref(seedStorage, paths.canaryPath('seed')),
      storageSdk.ref(seedStorage, paths.canaryPath('update')),
      storageSdk.ref(seedStorage, paths.canaryPath('create')),
      storageSdk.ref(seedStorage, paths.deniedControlPath),
      storageSdk.ref(seedStorage, paths.targetPath),
      storageSdk.ref(seedStorage, paths.granularPath),
    ];

    try {
      return await runWithOracleRulesRestored(session, async () => {
        return await runWithMethodProbeTeardown({
          async signInAll() {
            await signInOracleClientAuth(seedAuth, sa, `st-method-seed-${runId}`);
            await signInOracleClientAuth(updateMethodAuth, sa, `st-method-update-${runId}`);
            await signInOracleClientAuth(createMethodAuth, sa, `st-method-create-${runId}`);
            return {
              seedUid: seedAuth.currentUser?.uid ?? '',
              updateMethodUid: updateMethodAuth.currentUser?.uid ?? '',
              createMethodUid: createMethodAuth.currentUser?.uid ?? '',
            };
          },
          async deployRules(uids) {
            await session.deploy(updateMetadataMethodOracleTarget(storageBucket, runId, uids));
          },
          async runBody() {
            await new Promise((resolve) => setTimeout(resolve, 10_000));

            const uploadCanaryWithRetry = async (
              targetStorage: ReturnType<typeof storageSdk.getStorage>,
              role: 'seed' | 'update' | 'create',
            ): Promise<void> => {
              const canaryRef = storageSdk.ref(targetStorage, paths.canaryPath(role));
              let lastErr: unknown = null;
              for (let attempt = 0; attempt < 8; attempt += 1) {
                try {
                  await storageSdk.uploadBytes(canaryRef, new Uint8Array([0x01]), {
                    contentType: 'application/octet-stream',
                  });
                  return;
                } catch (err) {
                  lastErr = err;
                  const details = extractObservedErrorDetails(err);
                  if (details.code === 'storage/unauthorized' && attempt < 7) {
                    await new Promise((resolve) => setTimeout(resolve, 3_000));
                    continue;
                  }
                  throw err;
                }
              }
              throw lastErr;
            };

            await uploadCanaryWithRetry(seedStorage, 'seed');
            await uploadCanaryWithRetry(updateMethodStorage, 'update');
            await uploadCanaryWithRetry(createMethodStorage, 'create');

            return await observeStorageUpdateMetadataRequestMethod({
              async seedObjects() {
                const seedMeta = {
                  contentType: 'text/plain',
                  customMetadata: { stage: 'seed' },
                };
                await storageSdk.uploadBytes(
                  storageSdk.ref(seedStorage, paths.deniedControlPath),
                  SEED_BYTES,
                  seedMeta,
                );
                const targetUpload = await storageSdk.uploadBytes(
                  storageSdk.ref(seedStorage, paths.targetPath),
                  SEED_BYTES,
                  seedMeta,
                );
                const granularUpload = await storageSdk.uploadBytes(
                  storageSdk.ref(seedStorage, paths.granularPath),
                  SEED_BYTES,
                  seedMeta,
                );
                return {
                  targetInitial: summarizeStoredMetadata(targetUpload.metadata),
                  granularInitial: summarizeStoredMetadata(granularUpload.metadata),
                };
              },
              attemptDeniedControlCreateClient() {
                return captureUpdateMetadataAttempt(() =>
                  storageSdk.updateMetadata(
                    storageSdk.ref(createMethodStorage, paths.deniedControlPath),
                    { customMetadata: { stage: 'denied-create' } },
                  ),
                );
              },
              attemptDeniedControlUpdateClient() {
                return captureUpdateMetadataAttempt(() =>
                  storageSdk.updateMetadata(
                    storageSdk.ref(updateMethodStorage, paths.deniedControlPath),
                    { customMetadata: { stage: 'denied-update' } },
                  ),
                );
              },
              attemptTargetWhenMethodEqualsCreate() {
                return captureUpdateMetadataAttempt(() =>
                  storageSdk.updateMetadata(
                    storageSdk.ref(createMethodStorage, paths.targetPath),
                    { customMetadata: { stage: 'create-arm' } },
                  ),
                );
              },
              async readTargetMetadata() {
                const meta = await storageSdk.getMetadata(
                  storageSdk.ref(seedStorage, paths.targetPath),
                );
                return summarizeStoredMetadata(meta);
              },
              attemptTargetWhenMethodEqualsUpdate() {
                return captureUpdateMetadataAttempt(() =>
                  storageSdk.updateMetadata(
                    storageSdk.ref(updateMethodStorage, paths.targetPath),
                    { customMetadata: { stage: 'update-arm' } },
                  ),
                );
              },
              attemptGranularAllowCreateVerb() {
                return captureUpdateMetadataAttempt(() =>
                  storageSdk.updateMetadata(
                    storageSdk.ref(createMethodStorage, paths.granularPath),
                    { customMetadata: { stage: 'create-verb' } },
                  ),
                );
              },
              async readGranularMetadata() {
                const meta = await storageSdk.getMetadata(
                  storageSdk.ref(seedStorage, paths.granularPath),
                );
                return summarizeStoredMetadata(meta);
              },
              attemptGranularAllowUpdateVerb() {
                return captureUpdateMetadataAttempt(() =>
                  storageSdk.updateMetadata(
                    storageSdk.ref(updateMethodStorage, paths.granularPath),
                    { customMetadata: { stage: 'update-verb' } },
                  ),
                );
              },
            });
          },
          async deleteObjects() {
            for (const itemRef of cleanupRefs) {
              await storageSdk.deleteObject(itemRef).catch(() => undefined);
            }
          },
          async deleteSignedInUsers() {
            for (const authInstance of [seedAuth, updateMethodAuth, createMethodAuth]) {
              if (authInstance.currentUser) {
                await deleteUser(authInstance.currentUser).catch(() => undefined);
              }
            }
          },
        });
      });
    } finally {
      await Promise.all([
        deleteApp(seedApp).catch(() => undefined),
        deleteApp(updateMethodApp).catch(() => undefined),
        deleteApp(createMethodApp).catch(() => undefined),
      ]);
      detachSignals();
    }
  },
};
