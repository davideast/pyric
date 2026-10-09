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
  firebaseStorageObject,
  firebaseStorageUpload,
  gcsMetadata,
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
  STORED_UPDATE_PROBES,
  STORED_UPDATE_SEEDS,
  STORED_UPLOADS,
  probePath,
  probeWrite,
  requestResourceRules,
  storedSeedPath,
  storedUpdatePath,
  storedUploadPath,
  type ProbeGroup,
  type StoredUpdateSeed,
} from './storage-request-resource-probes.ts';

const PROBE_LIMITS = { storage: 340, firestoreWrite: 0, rules: 12, iam: 0 };
const CLEANUP_LIMITS = { storage: 380, firestoreWrite: 0, rules: 8, iam: 0 };

/** The project a capture targets and an OAuth access token for it. */
export interface ProbeAccess {
  projectId: string;
  resolveToken(): Promise<string>;
}

/**
 * Credentials for the capture: the oracle service account when
 * `PYRIC_ORACLE_SA_PATH` is set, otherwise the Rules parity scope
 * (packages/pyric/test/rules/parity/credential.ts).
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
  const storedObjects: Record<string, StoredObjectViews | StorageDecision> = {};
  const storedUpdateBehavior: Record<StoredUpdateSeed, Record<string, 'ALLOW' | 'DENY'>> = { client: {}, gcs: {} };
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

    // Read back what production stores for client uploads that set or leave
    // unset the content fields, and for an object written through the GCS JSON
    // API: the GCS object resource, and the Firebase Storage object resource a
    // client getMetadata reads.
    const readBack = async (path: string): Promise<StoredObjectViews> => ({
      gcs: storedContentFields(await gcsMetadata(config.storageBucket, path, headers, budget)),
      client: clientContentFields(await firebaseStorageObject(config.storageBucket, path, budget)),
    });
    for (const upload of STORED_UPLOADS) {
      const path = storedUploadPath(prefix, upload);
      createdObjects.add(path);
      const result = await firebaseStorageUpload(config.storageBucket, path, PROBE_PAYLOAD, budget, fetch, upload.fields);
      storedObjects[upload.id] = result.allowed ? await readBack(path) : result;
    }
    const seedPath = storedSeedPath(prefix);
    createdObjects.add(seedPath);
    await gcsUpload(config.storageBucket, seedPath, PROBE_PAYLOAD, headers, budget);
    storedObjects['gcs-json-api-seed'] = await readBack(seedPath);

    // A metadata update that sets only custom metadata, over an object a
    // client upload or the GCS JSON API wrote with no content fields.
    for (const seed of STORED_UPDATE_SEEDS) {
      for (const probe of STORED_UPDATE_PROBES) {
        const path = storedUpdatePath(prefix, seed, probe.id);
        createdObjects.add(path);
        if (seed === 'gcs') {
          await gcsUpload(config.storageBucket, path, PROBE_PAYLOAD, headers, budget);
        } else {
          const seeded = await firebaseStorageUpload(
            config.storageBucket, path, PROBE_PAYLOAD, budget, fetch, { contentType: SETTABLE_FIELDS.contentType },
          );
          if (!seeded.allowed) throw new Error(`stored-update seed upload denied: ${seeded.code} ${seeded.message}`);
        }
        const result = await firebaseStorageMetadataUpdate(config.storageBucket, path, { ...CUSTOM_METADATA }, budget);
        storedUpdateBehavior[seed][probe.id] = result.allowed ? 'ALLOW' : 'DENY';
        diagnostics[`stored-update/${seed}/${probe.id}`] = result;
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
      storedUploads: STORED_UPLOADS,
      storedObjects,
      storedUpdateBehavior,
    },
  )]);
}

/** The content fields of a stored object; a field the object does not carry is `null`. */
interface StoredContentFields {
  contentType: string | null;
  contentDisposition: string | null;
  contentEncoding: string | null;
}

/** A stored object as the GCS JSON API and a Firebase Storage client read it. */
interface StoredObjectViews {
  gcs: StoredContentFields;
  client: StoredContentFields | StorageDecision;
}

function storedContentFields(object: Partial<Record<keyof StoredContentFields, unknown>>): StoredContentFields {
  const field = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    contentType: field(object.contentType),
    contentDisposition: field(object.contentDisposition),
    contentEncoding: field(object.contentEncoding),
  };
}

function clientContentFields(object: Record<string, unknown> | StorageDecision): StoredContentFields | StorageDecision {
  return 'allowed' in object ? object as StorageDecision : storedContentFields(object);
}
