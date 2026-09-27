/**
 * Real-resource capture of the fields production puts on Storage
 * `request.resource`.
 *
 * The Rules Test API takes `request.resource` as a literal map from the
 * caller, so it cannot show which fields production itself populates. This
 * rig deploys the run-scoped match block from storage-request-resource-probes.ts,
 * performs real client uploads to new paths (create), real client metadata
 * updates (update), and real client uploads over seeded objects (overwrite),
 * and records one verdict per probe.
 *
 * The previous Storage release pointer is restored in finally, then every
 * object under the run prefix is deleted and absence is verified.
 */
import { accessHeaders, resolveServiceAccount, storageConfig } from './storage-stdlib-real-api.ts';
import { RequestBudget, runCleanupSteps } from './storage-stdlib-real-budget.ts';
import {
  deleteStorageObjects,
  firebaseStorageMetadataUpdate,
  firebaseStorageUpload,
  gcsUpload,
  type StorageDecision,
} from './storage-stdlib-real-objects.ts';
import { storageObservation, writeStorageObservations } from './storage-stdlib-real-observations.ts';
import {
  STORAGE_MATCH,
  activateStorageSource,
  injectIntoMatch,
  preflightStorageSource,
  replaceRulesFile,
  restoreStorageRelease,
  selectRulesFile,
  storageRulesSnapshot,
} from './storage-stdlib-real-rules.ts';
import {
  CUSTOM_METADATA,
  OBSERVATION_NAME,
  PROBE_GROUPS,
  PROBE_PAYLOAD,
  PROBE_REPLACEMENT,
  SETTABLE_FIELDS,
  probePath,
  probeWrite,
  requestResourceRules,
  type ProbeGroup,
} from './storage-request-resource-probes.ts';

const PROBE_LIMITS = { storage: 300, firestoreWrite: 0, rules: 12, iam: 0 };
const CLEANUP_LIMITS = { storage: 340, firestoreWrite: 0, rules: 8, iam: 0 };

/** The project a capture targets and an OAuth access token for it. */
export interface ProbeAccess {
  projectId: string;
  resolveToken(): Promise<string>;
}

/**
 * Credentials for the capture: the oracle service account when
 * `PYRIC_ORACLE_SA_PATH` is set, otherwise the Rules parity scope, which reads
 * `PARITY_SA_BASE64` or falls back to the firebase CLI login for
 * `PARITY_PROJECT_ID`.
 */
export async function resolveProbeAccess(): Promise<ProbeAccess> {
  const saPath = process.env.PYRIC_ORACLE_SA_PATH;
  if (saPath) {
    const sa = resolveServiceAccount(saPath);
    return { projectId: sa.project_id, resolveToken: async () => (await accessHeaders(sa)).auth.Authorization.slice('Bearer '.length) };
  }
  const { parityScope } = await import('../../../packages/pyric/test/rules/parity/harness.ts');
  return parityScope();
}

/** Runs under the real-resource run lock the entry point holds. */
export async function runStorageRequestResourceFields(access: ProbeAccess): Promise<void> {
  const token = await access.resolveToken();
  const auth = { Authorization: `Bearer ${token}` };
  const headers = { auth, json: { ...auth, 'Content-Type': 'application/json' } };
  const sa = { project_id: access.projectId };
  const budget = new RequestBudget({ ...PROBE_LIMITS });
  const cleanupBudget = new RequestBudget({ ...CLEANUP_LIMITS });
  budget.take('rules');
  const config = await storageConfig(sa, headers);
  const snapshot = await storageRulesSnapshot(sa, config.storageBucket, headers, budget);
  const rulesFile = selectRulesFile(snapshot.ruleset);
  const runId = `r${Date.now().toString(36)}`;
  const runPrefix = `__pyric_storage_stdlib/${runId}`;
  const prefix = `${runPrefix}/request-resource`;
  const createdObjects = new Set<string>();
  const behavior: Record<ProbeGroup, Record<string, 'ALLOW' | 'DENY'>> = { create: {}, update: {}, overwrite: {} };
  const diagnostics: Record<string, StorageDecision> = {};
  let releaseRestored = false;
  let objectsRemoved = false;

  const files = replaceRulesFile(
    snapshot.ruleset,
    rulesFile,
    injectIntoMatch(rulesFile.content, STORAGE_MATCH, '`match /b/{bucket}/o`', requestResourceRules(prefix)),
  );
  await preflightStorageSource(sa, config.storageBucket, headers, budget, files, `${prefix}/canary.bin`);

  try {
    // Seed one existing object per update and overwrite probe before the probe rules go live.
    for (const { group, probes } of PROBE_GROUPS) {
      if (group === 'create') continue;
      for (const probe of probes) {
        const path = probePath(prefix, group, probe.id);
        createdObjects.add(path);
        await gcsUpload(config.storageBucket, path, PROBE_PAYLOAD, headers, budget);
      }
    }
    await activateStorageSource(sa, headers, budget, snapshot, files);

    createdObjects.add(`${prefix}/canary.bin`);
    const canary = await firebaseStorageUpload(config.storageBucket, `${prefix}/canary.bin`, PROBE_PAYLOAD, budget);
    if (!canary.allowed) throw new Error(`request.resource probe rules did not activate: ${canary.code} ${canary.message}`);

    for (const { group, probes } of PROBE_GROUPS) {
      for (const probe of probes) {
        const path = probePath(prefix, group, probe.id);
        createdObjects.add(path);
        const write = probeWrite(group, probe.id);
        let result: StorageDecision;
        if (write.kind === 'upload') {
          result = await firebaseStorageUpload(config.storageBucket, path, write.bytes, budget, fetch, write.fields);
        } else {
          const { metadata, ...fields } = write.fields;
          result = await firebaseStorageMetadataUpdate(
            config.storageBucket, path, metadata as Record<string, string>, budget, fetch, fields,
          );
        }
        behavior[group][probe.id] = result.allowed ? 'ALLOW' : 'DENY';
        diagnostics[`${group}/${probe.id}`] = result;
      }
    }
  } finally {
    await runCleanupSteps([
      { label: 'restore Storage release', run: async () => { releaseRestored = await restoreStorageRelease(headers, cleanupBudget, snapshot); } },
      { label: 'delete Storage objects', run: async () => { objectsRemoved = await deleteStorageObjects(config.storageBucket, runPrefix, createdObjects, headers, cleanupBudget); } },
    ]);
  }
  if (!releaseRestored || !objectsRemoved) {
    throw new Error(`request.resource cleanup failed: releaseRestored=${releaseRestored} objectsRemoved=${objectsRemoved}`);
  }

  writeStorageObservations([storageObservation(
    OBSERVATION_NAME,
    'Real-resource Storage Rules probe of the fields production populates on request.resource for a client create, a client metadata update, and a client upload over an existing object, and their values relative to the upload, the stored resource, and request.time.',
    sa.project_id,
    config.storageBucket,
    behavior,
    diagnostics,
    { releaseRestored, objectsRemoved },
    budget,
    {
      cleanupRequestBudget: cleanupBudget.snapshot(),
      probeRules: requestResourceRules('<prefix>'),
      createFields: { ...SETTABLE_FIELDS, metadata: CUSTOM_METADATA, size: PROBE_PAYLOAD.byteLength },
      updateFields: { ...SETTABLE_FIELDS, metadata: CUSTOM_METADATA },
      overwriteFields: { contentType: SETTABLE_FIELDS.contentType, size: PROBE_REPLACEMENT.byteLength },
    },
  )]);
}
