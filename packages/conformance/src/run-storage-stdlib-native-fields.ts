import { deleteApp, initializeApp } from 'firebase/app';
import { getMetadata, getStorage, ref as storageRef, updateMetadata, uploadBytes } from 'firebase/storage';
import {
  accessHeaders,
  storageConfig,
  type ServiceAccount,
  type WebConfig,
} from './storage-stdlib-real-api.ts';
import {
  RequestBudget,
  STORAGE_CLEANUP_LIMITS,
  STORAGE_PROBE_LIMITS,
  runCleanupSteps,
} from './storage-stdlib-real-budget.ts';
import {
  deleteStorageObjects,
  gcsMetadata,
  gcsUpload,
  storageDecision,
  type GcsObject,
  type StorageDecision,
} from './storage-stdlib-real-objects.ts';
import {
  storageObservation,
  writeStorageObservations,
} from './storage-stdlib-real-observations.ts';
import {
  STORAGE_MATCH,
  activateStorageSource,
  injectIntoMatch,
  preflightStorageSource,
  replaceRulesFile,
  restoreStorageRelease,
  rulesLiteral,
  selectRulesFile,
  storageRulesSnapshot,
} from './storage-stdlib-real-rules.ts';

function nativeRules(runId: string, metadata: Record<string, GcsObject>): string {
  const prefix = `__pyric_storage_stdlib/${runId}/native`;
  const exact = metadata['stored-exact'];
  const identity = metadata['identity-mismatch'];
  const hash = metadata['hash-mismatch'];
  const time = metadata['time-mismatch'];
  if (!exact || !identity || !hash || !time) throw new Error('native metadata fixtures incomplete');
  const exactCondition = [
    `resource.generation == ${exact.generation}`,
    `resource.metageneration == ${exact.metageneration}`,
    `resource.md5Hash == ${rulesLiteral(exact.md5Hash)}`,
    `resource.crc32c == ${rulesLiteral(exact.crc32c)}`,
    `resource.etag == ${rulesLiteral(exact.etag)}`,
    `resource.timeCreated.toMillis() == ${Date.parse(exact.timeCreated)}`,
    `resource.updated.toMillis() == ${Date.parse(exact.updated)}`,
  ].join(' && ');
  return `
    // @pyric/storage-stdlib-native/${runId}
    match /${prefix}/canary.bin { allow create: if true; }
    match /${prefix}/stored-exact.bin { allow read: if ${exactCondition}; }
    match /${prefix}/identity-mismatch.bin { allow read: if resource.generation == ${BigInt(identity.generation) + 1n}; }
    match /${prefix}/hash-mismatch.bin { allow read: if resource.md5Hash == ${rulesLiteral(`${hash.md5Hash}-mismatch`)}; }
    match /${prefix}/time-mismatch.bin { allow read: if resource.updated.toMillis() == ${Date.parse(time.updated) + 1}; }
    match /${prefix}/incoming-exact.bin {
      allow create: if request.resource.md5Hash == ${rulesLiteral(exact.md5Hash)} && request.resource.crc32c == ${rulesLiteral(exact.crc32c)};
    }
    match /${prefix}/incoming-md5-mismatch.bin { allow create: if request.resource.md5Hash == 'mismatch'; }
    match /${prefix}/incoming-crc-mismatch.bin { allow create: if request.resource.crc32c == 'mismatch'; }
    match /${prefix}/incoming-excluded-version.bin { allow create: if request.resource.generation == 0; }
    match /${prefix}/incoming-excluded-etag.bin { allow create: if request.resource.etag == ''; }
    match /${prefix}/incoming-excluded-time.bin { allow create: if request.resource.timeCreated.toMillis() > 0; }
    match /${prefix}/metadata-update.bin {
      allow update: if request.resource.md5Hash == resource.md5Hash && request.resource.crc32c == resource.crc32c;
    }
    match /${prefix}/byte-overwrite-control.bin { allow write: if true; }
    match /${prefix}/byte-overwrite-md5.bin { allow write: if request.resource.md5Hash != resource.md5Hash; }
    match /${prefix}/byte-overwrite-crc.bin { allow write: if request.resource.crc32c != resource.crc32c; }
`;
}

export async function runStorageStdlibNativeFields(sa: ServiceAccount, web: WebConfig): Promise<void> {
  const headers = await accessHeaders(sa);
  const config = await storageConfig(sa, headers);
  if (config.projectId !== web.projectId) throw new Error('Web config and Storage probe service account target different projects');
  const budget = new RequestBudget({ ...STORAGE_PROBE_LIMITS });
  const cleanupBudget = new RequestBudget({ ...STORAGE_CLEANUP_LIMITS });
  const snapshot = await storageRulesSnapshot(sa, config.storageBucket, headers, budget);
  const rulesFile = selectRulesFile(snapshot.ruleset);
  const runId = `r${Date.now().toString(36)}`;
  const prefix = `__pyric_storage_stdlib/${runId}`;
  const nativePrefix = `${prefix}/native`;
  const payload = new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]);
  const replacement = new Uint8Array([0x72, 0x75, 0x6c, 0x65, 0x73]);
  const createdObjects = new Set<string>();
  const seedNames = [
    'stored-exact', 'identity-mismatch', 'hash-mismatch', 'time-mismatch',
    'metadata-update', 'byte-overwrite-control', 'byte-overwrite-md5', 'byte-overwrite-crc',
  ];
  const serverMetadata: Record<string, GcsObject> = {};
  const behavior: Record<string, unknown> = {};
  const diagnostics: Record<string, unknown> = {};
  let releaseRestored = false;
  let objectsRemoved = false;
  let app: ReturnType<typeof initializeApp> | undefined;

  const template = injectIntoMatch(
    rulesFile.content,
    STORAGE_MATCH,
    '`match /b/{bucket}/o`',
    `\n    match /${nativePrefix}/canary.bin { allow create: if true; }\n`,
  );
  await preflightStorageSource(sa, config.storageBucket, headers, budget, replaceRulesFile(snapshot.ruleset, rulesFile, template), `${nativePrefix}/canary.bin`);

  try {
    for (const name of seedNames) {
      const path = `${nativePrefix}/${name}.bin`;
      createdObjects.add(path);
      serverMetadata[name] = await gcsUpload(config.storageBucket, path, payload, headers, budget);
    }
    const source = injectIntoMatch(rulesFile.content, STORAGE_MATCH, '`match /b/{bucket}/o`', nativeRules(runId, serverMetadata));
    const files = replaceRulesFile(snapshot.ruleset, rulesFile, source);
    await preflightStorageSource(sa, config.storageBucket, headers, budget, files, `${nativePrefix}/canary.bin`);
    await activateStorageSource(sa, headers, budget, snapshot, files);

    app = initializeApp({ ...web, storageBucket: config.storageBucket }, `storage-stdlib-native-${runId}`);
    const storage = getStorage(app);
    const clientRead = async (family: string): Promise<StorageDecision> => {
      budget.take('storage');
      try {
        await getMetadata(storageRef(storage, `${nativePrefix}/${family}.bin`));
        return storageDecision();
      } catch (error) {
        return storageDecision(error);
      }
    };
    const clientUpload = async (family: string, bytes = payload): Promise<StorageDecision> => {
      budget.take('storage');
      const path = `${nativePrefix}/${family}.bin`;
      createdObjects.add(path);
      try {
        await uploadBytes(storageRef(storage, path), bytes);
        return storageDecision();
      } catch (error) {
        return storageDecision(error);
      }
    };

    const canary = await clientUpload('canary');
    if (!canary.allowed) throw new Error(`native probe rules did not activate: ${canary.code} ${canary.message}`);
    for (const family of ['stored-exact', 'identity-mismatch', 'hash-mismatch', 'time-mismatch']) {
      const result = await clientRead(family);
      behavior[family] = result.allowed ? 'ALLOW' : 'DENY';
      diagnostics[family] = result;
    }
    for (const family of ['incoming-exact', 'incoming-md5-mismatch', 'incoming-crc-mismatch', 'incoming-excluded-version', 'incoming-excluded-etag', 'incoming-excluded-time']) {
      const result = await clientUpload(family);
      behavior[family] = result.allowed ? 'ALLOW' : 'DENY';
      diagnostics[family] = result;
    }

    const metadataPath = `${nativePrefix}/metadata-update.bin`;
    budget.take('storage');
    try {
      await updateMetadata(storageRef(storage, metadataPath), { customMetadata: { probe: runId } });
      behavior['metadata-update'] = 'ALLOW';
    } catch (error) {
      behavior['metadata-update'] = 'DENY';
      diagnostics['metadata-update'] = storageDecision(error);
    }
    const metadataAfter = await gcsMetadata(config.storageBucket, metadataPath, headers, budget);
    const metadataBefore = serverMetadata['metadata-update'];
    behavior['metadata-update-relations'] = {
      generationPreserved: metadataAfter.generation === metadataBefore?.generation,
      hashesPreserved: metadataAfter.md5Hash === metadataBefore?.md5Hash && metadataAfter.crc32c === metadataBefore?.crc32c,
      timeCreatedPreserved: metadataAfter.timeCreated === metadataBefore?.timeCreated,
      metagenerationAdvanced: Number(metadataAfter.metageneration) > Number(metadataBefore?.metageneration),
      updatedAdvanced: Date.parse(metadataAfter.updated) > Date.parse(metadataBefore?.updated ?? ''),
    };

    for (const family of ['byte-overwrite-control', 'byte-overwrite-md5', 'byte-overwrite-crc']) {
      const overwrite = await clientUpload(family, replacement);
      behavior[family] = overwrite.allowed ? 'ALLOW' : 'DENY';
      diagnostics[family] = overwrite;
      const overwriteAfter = await gcsMetadata(config.storageBucket, `${nativePrefix}/${family}.bin`, headers, budget);
      const overwriteBefore = serverMetadata[family];
      behavior[`${family}-relations`] = {
        generationAdvanced: Number(overwriteAfter.generation) > Number(overwriteBefore?.generation),
        md5Changed: overwriteAfter.md5Hash !== overwriteBefore?.md5Hash,
        crc32cChanged: overwriteAfter.crc32c !== overwriteBefore?.crc32c,
        timeCreatedAdvanced: Date.parse(overwriteAfter.timeCreated) >= Date.parse(overwriteBefore?.timeCreated ?? ''),
      };
    }
  } finally {
    await runCleanupSteps([
      { label: 'restore Storage release', run: async () => { releaseRestored = await restoreStorageRelease(headers, cleanupBudget, snapshot); } },
      { label: 'delete Storage objects', run: async () => { objectsRemoved = await deleteStorageObjects(config.storageBucket, prefix, createdObjects, headers, cleanupBudget); } },
      { label: 'delete Firebase app', run: async () => { if (app) await deleteApp(app); } },
    ]);
  }
  if (!releaseRestored || !objectsRemoved) throw new Error(`native cleanup failed: releaseRestored=${releaseRestored} objectsRemoved=${objectsRemoved}`);

  writeStorageObservations([storageObservation(
    'stdlib-realstorage-p2-native-object-fields',
    'Real-resource Storage Rules visibility and relationships for server-populated generation, metageneration, hashes, etag, creation/update time, metadata-only updates, and byte overwrites.',
    sa.project_id,
    config.storageBucket,
    behavior,
    diagnostics,
    { releaseRestored, objectsRemoved },
    budget,
    {
      cleanupRequestBudget: cleanupBudget.snapshot(),
      serverFields: {
        generation: serverMetadata['stored-exact']?.generation,
        metageneration: serverMetadata['stored-exact']?.metageneration,
        hasMd5Hash: typeof serverMetadata['stored-exact']?.md5Hash === 'string',
        hasCrc32c: typeof serverMetadata['stored-exact']?.crc32c === 'string',
        hasEtag: typeof serverMetadata['stored-exact']?.etag === 'string',
        timeCreated: serverMetadata['stored-exact']?.timeCreated,
        updated: serverMetadata['stored-exact']?.updated,
      },
    },
  )]);
}
