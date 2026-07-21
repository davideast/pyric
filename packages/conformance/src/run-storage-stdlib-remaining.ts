import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  getMetadata,
  getStorage,
  ref as storageRef,
  updateMetadata,
  uploadBytes,
} from 'firebase/storage';
import {
  RequestBudget,
  accessHeaders,
  canonicalPolicy,
  firestoreDocumentName,
  injectIntoMatch,
  jsonRequest,
  replaceRulesFile,
  resolveServiceAccount,
  rulesLiteral,
  runCleanupSteps,
  selectRulesFile,
  type IamPolicy,
  type Release,
  type Ruleset,
  type ServiceAccount,
  type WebConfig,
} from './storage-stdlib-real-support.ts';

type Mode = 'native-fields' | 'remaining-cross-service';
type Headers = Awaited<ReturnType<typeof accessHeaders>>;
type Decision = { allowed: boolean; code?: string; message?: string };
type GcsObject = {
  name: string;
  bucket: string;
  generation: string;
  metageneration: string;
  size: string;
  md5Hash: string;
  crc32c: string;
  etag: string;
  timeCreated: string;
  updated: string;
  metadata?: Record<string, string>;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations', 'storage-rules');
const RULES_API = 'https://firebaserules.googleapis.com/v1';
const FIREBASE_API = 'https://firebase.googleapis.com/v1beta1';
const IAM_SETTLE_MS = 120_000;
const IAM_RETRY_MS = 30_000;
const IAM_RETRY_LIMIT = 6;
const STORAGE_MATCH = /(match\s+\/b\/\{bucket\}\/o\s*\{)/;
const LIMITS = { storage: 40, firestoreWrite: 25, rules: 20, iam: 12 } as const;

function resolvedFirebaseVersion(): string {
  return (JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('firebase/package.json')), 'utf8')) as { version: string }).version;
}

function writeObservations(values: Array<Record<string, unknown>>): void {
  mkdirSync(OBS_DIR, { recursive: true });
  for (const value of values) {
    const path = join(OBS_DIR, `${value.name as string}.json`);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    console.log(`[storage-stdlib:remaining] wrote ${path}`);
  }
}

function observation(
  name: string,
  description: string,
  projectId: string,
  bucket: string,
  behavior: Record<string, unknown>,
  diagnostics: Record<string, unknown>,
  cleanup: Record<string, boolean>,
  budget: RequestBudget,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    matrixRow: '',
    rowIds: [],
    description,
    observedAt: new Date().toISOString(),
    fbSdkVersion: resolvedFirebaseVersion(),
    projectId,
    bucket,
    behavior,
    diagnostics,
    cleanup,
    requestBudget: budget.snapshot(),
    ...extra,
  };
}

async function storageConfig(sa: ServiceAccount, headers: Headers): Promise<{ projectId: string; storageBucket: string }> {
  return jsonRequest(
    `${FIREBASE_API}/projects/${sa.project_id}/adminSdkConfig`,
    { headers: headers.auth },
    'read Admin SDK config',
  );
}

async function storageRulesSnapshot(sa: ServiceAccount, bucket: string, headers: Headers, budget: RequestBudget): Promise<{
  release: Release;
  ruleset: Ruleset;
  releaseName: string;
  releaseUrl: string;
}> {
  const releaseName = `projects/${sa.project_id}/releases/firebase.storage/${bucket}`;
  const releaseUrl = `${RULES_API}/${releaseName}`;
  budget.take('rules', 2);
  const release = await jsonRequest<Release>(releaseUrl, { headers: headers.auth }, 'snapshot Storage release');
  const ruleset = await jsonRequest<Ruleset>(`${RULES_API}/${release.rulesetName}`, { headers: headers.auth }, 'snapshot Storage ruleset');
  return { release, ruleset, releaseName, releaseUrl };
}

async function preflightStorageSource(
  sa: ServiceAccount,
  bucket: string,
  headers: Headers,
  budget: RequestBudget,
  files: Ruleset['source']['files'],
  path: string,
): Promise<void> {
  budget.take('rules');
  const response = await fetch(`${RULES_API}/projects/${sa.project_id}:test`, {
    method: 'POST',
    headers: headers.json,
    body: JSON.stringify({
      source: { files },
      testSuite: { testCases: [{ expectation: 'ALLOW', request: { method: 'create', path: `/b/${bucket}/o/${path}`, resource: { size: 5 } } }] },
    }),
  });
  const result = await response.json() as { issues?: unknown[]; testResults?: Array<{ state?: string }>; error?: unknown };
  if (!response.ok || result.issues?.length || result.error || result.testResults?.[0]?.state !== 'SUCCESS') {
    throw new Error(`Storage source preflight failed: ${response.status} ${JSON.stringify(result)}`);
  }
}

async function activateStorageSource(
  sa: ServiceAccount,
  headers: Headers,
  budget: RequestBudget,
  snapshot: Awaited<ReturnType<typeof storageRulesSnapshot>>,
  files: Ruleset['source']['files'],
): Promise<void> {
  budget.take('rules', 2);
  const created = await jsonRequest<{ name: string }>(
    `${RULES_API}/projects/${sa.project_id}/rulesets`,
    { method: 'POST', headers: headers.json, body: JSON.stringify({ source: { files } }) },
    'create probe Storage ruleset',
  );
  await jsonRequest(
    snapshot.releaseUrl,
    { method: 'PATCH', headers: headers.json, body: JSON.stringify({ release: { name: snapshot.releaseName, rulesetName: created.name } }) },
    'activate probe Storage ruleset',
  );
}

async function restoreStorageRelease(
  headers: Headers,
  budget: RequestBudget,
  snapshot: Awaited<ReturnType<typeof storageRulesSnapshot>>,
): Promise<boolean> {
  budget.take('rules', 2);
  await jsonRequest(
    snapshot.releaseUrl,
    { method: 'PATCH', headers: headers.json, body: JSON.stringify({ release: { name: snapshot.releaseName, rulesetName: snapshot.release.rulesetName } }) },
    'restore original Storage release',
  );
  const restored = await jsonRequest<Release>(snapshot.releaseUrl, { headers: headers.auth }, 'verify original Storage release');
  return restored.rulesetName === snapshot.release.rulesetName;
}

async function gcsUpload(
  bucket: string,
  path: string,
  payload: Uint8Array,
  headers: Headers,
  budget: RequestBudget,
): Promise<GcsObject> {
  budget.take('storage');
  return jsonRequest<GcsObject>(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(path)}`,
    { method: 'POST', headers: { ...headers.auth, 'Content-Type': 'application/octet-stream' }, body: payload.buffer as ArrayBuffer },
    `upload seed object ${path}`,
  );
}

async function gcsMetadata(bucket: string, path: string, headers: Headers, budget: RequestBudget): Promise<GcsObject> {
  budget.take('storage');
  return jsonRequest<GcsObject>(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
    { headers: headers.auth },
    `read object metadata ${path}`,
  );
}

async function deleteObjects(
  bucket: string,
  prefix: string,
  objects: Set<string>,
  headers: Headers,
  budget: RequestBudget,
): Promise<boolean> {
  for (const path of objects) {
    budget.take('storage');
    const response = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
      { method: 'DELETE', headers: headers.auth },
    );
    if (!response.ok && response.status !== 404) throw new Error(`delete probe object failed: ${response.status} ${await response.text()}`);
  }
  budget.take('storage');
  const list = await jsonRequest<{ items?: unknown[] }>(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(prefix)}`,
    { headers: headers.auth },
    'verify object cleanup',
  );
  return (list.items?.length ?? 0) === 0;
}

function decision(error?: unknown): Decision {
  if (!error) return { allowed: true };
  return {
    allowed: false,
    code: (error as { code?: string }).code,
    message: error instanceof Error ? error.message : String(error),
  };
}

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

async function runNativeFields(sa: ServiceAccount, web: WebConfig): Promise<void> {
  const headers = await accessHeaders(sa);
  const config = await storageConfig(sa, headers);
  if (config.projectId !== web.projectId) throw new Error('Web config and Storage probe service account target different projects');
  const budget = new RequestBudget({ ...LIMITS });
  const snapshot = await storageRulesSnapshot(sa, config.storageBucket, headers, budget);
  const rulesFile = selectRulesFile(snapshot.ruleset);
  const runId = `r${Date.now().toString(36)}`;
  const prefix = `__pyric_storage_stdlib/${runId}`;
  const nativePrefix = `${prefix}/native`;
  const payload = new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]);
  const replacement = new Uint8Array([0x72, 0x75, 0x6c, 0x65, 0x73]);
  const createdObjects = new Set<string>();
  const seedNames = [
    'stored-exact',
    'identity-mismatch',
    'hash-mismatch',
    'time-mismatch',
    'metadata-update',
    'byte-overwrite-control',
    'byte-overwrite-md5',
    'byte-overwrite-crc',
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
      serverMetadata[name] = await gcsUpload(config.storageBucket, path, payload, headers, budget);
      createdObjects.add(path);
    }
    const block = nativeRules(runId, serverMetadata);
    const source = injectIntoMatch(rulesFile.content, STORAGE_MATCH, '`match /b/{bucket}/o`', block);
    const files = replaceRulesFile(snapshot.ruleset, rulesFile, source);
    await preflightStorageSource(sa, config.storageBucket, headers, budget, files, `${nativePrefix}/canary.bin`);
    await activateStorageSource(sa, headers, budget, snapshot, files);

    app = initializeApp({ ...web, storageBucket: config.storageBucket }, `storage-stdlib-native-${runId}`);
    const storage = getStorage(app);
    const clientRead = async (family: string): Promise<Decision> => {
      budget.take('storage');
      try {
        await getMetadata(storageRef(storage, `${nativePrefix}/${family}.bin`));
        return decision();
      } catch (error) {
        return decision(error);
      }
    };
    const clientUpload = async (family: string, bytes = payload): Promise<Decision> => {
      budget.take('storage');
      const path = `${nativePrefix}/${family}.bin`;
      try {
        await uploadBytes(storageRef(storage, path), bytes);
        createdObjects.add(path);
        return decision();
      } catch (error) {
        return decision(error);
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
      diagnostics['metadata-update'] = decision(error);
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
      { label: 'restore Storage release', run: async () => { releaseRestored = await restoreStorageRelease(headers, budget, snapshot); } },
      { label: 'delete Storage objects', run: async () => { objectsRemoved = await deleteObjects(config.storageBucket, prefix, createdObjects, headers, budget); } },
      { label: 'delete Firebase app', run: async () => { if (app) await deleteApp(app); } },
    ]);
  }
  if (!releaseRestored || !objectsRemoved) throw new Error(`native cleanup failed: releaseRestored=${releaseRestored} objectsRemoved=${objectsRemoved}`);

  writeObservations([observation(
    'stdlib-realstorage-p2-native-object-fields',
    'Real-resource Storage Rules visibility and relationships for server-populated generation, metageneration, hashes, etag, creation/update time, metadata-only updates, and byte overwrites.',
    sa.project_id,
    config.storageBucket,
    behavior,
    diagnostics,
    { releaseRestored, objectsRemoved },
    budget,
    {
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

function crossServiceRules(runId: string): string {
  const doc = (database: string, id: string) => `/databases/${database}/documents/__pyric_storage_stdlib/${runId}/docs/${id}`;
  return `
    // @pyric/storage-stdlib-remaining/${runId}
    match /__pyric_storage_stdlib/${runId}/compile-canary/{id} { allow create: if true; }
    match /__pyric_storage_stdlib/${runId}/iam-canary/{id} { allow write: if firestore.get(${doc('(default)', 'iam')}).data.allow == true; }
    match /__pyric_storage_stdlib/${runId}/consistency-true/{id} { allow write: if firestore.get(${doc('(default)', 'consistency')}).data.allow == true; }
    match /__pyric_storage_stdlib/${runId}/consistency-false/{id} { allow write: if firestore.get(${doc('(default)', 'consistency')}).data.allow == false; }
    match /__pyric_storage_stdlib/${runId}/named-default/{id} { allow write: if firestore.get(${doc('(default)', 'named')}).data.allow == true; }
    match /__pyric_storage_stdlib/${runId}/named-probes/{id} { allow write: if firestore.get(${doc('probes', 'named')}).data.allow == true; }
    match /__pyric_storage_stdlib/${runId}/isolation/{id} { allow write: if firestore.get(${doc('(default)', 'isolation')}).data.allow == true; }
`;
}

async function patchDocument(name: string, allow: boolean, headers: Headers, budget: RequestBudget): Promise<{ updateTime?: string }> {
  budget.take('firestoreWrite');
  return jsonRequest(
    `https://firestore.googleapis.com/v1/${name}`,
    { method: 'PATCH', headers: headers.json, body: JSON.stringify({ fields: { allow: { booleanValue: allow } } }) },
    `write probe document ${name}`,
  );
}

async function verifyDocument(name: string, allow: boolean, headers: Headers): Promise<void> {
  const document = await jsonRequest<{ fields?: { allow?: { booleanValue?: boolean } } }>(
    `https://firestore.googleapis.com/v1/${name}`,
    { headers: headers.auth },
    `verify probe document ${name}`,
  );
  if (document.fields?.allow?.booleanValue !== allow) throw new Error(`probe document ${name} did not contain allow=${allow}`);
}

async function deleteDocuments(targets: Array<{ name: string; headers: Headers }>, budget: RequestBudget): Promise<boolean> {
  for (const target of targets) {
    budget.take('firestoreWrite');
    const response = await fetch(`https://firestore.googleapis.com/v1/${target.name}`, { method: 'DELETE', headers: target.headers.auth });
    if (!response.ok && response.status !== 404) throw new Error(`delete probe document failed: ${response.status} ${await response.text()}`);
  }
  const checks = await Promise.all(targets.map((target) => fetch(`https://firestore.googleapis.com/v1/${target.name}`, { headers: target.headers.auth })));
  return checks.every((response) => response.status === 404);
}

async function withTemporaryIam<T>(
  sa: ServiceAccount,
  headers: Headers,
  budget: RequestBudget,
  work: (iamChanged: boolean) => Promise<T>,
): Promise<{ value: T; iamChanged: boolean; iamRestored: boolean }> {
  budget.take('iam', 2);
  const project = await jsonRequest<{ projectNumber: string }>(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}`,
    { headers: headers.auth },
    'read project number',
  );
  const policyUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}:getIamPolicy`;
  const original = await jsonRequest<IamPolicy>(
    policyUrl,
    { method: 'POST', headers: headers.json, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) },
    'snapshot IAM policy',
  );
  const role = 'roles/firebaserules.firestoreServiceAgent';
  const member = `serviceAccount:service-${project.projectNumber}@gcp-sa-firebasestorage.iam.gserviceaccount.com`;
  const next = structuredClone(original);
  next.version = Math.max(next.version ?? 0, 3);
  next.bindings ??= [];
  const alreadyGranted = next.bindings.some((entry) => entry.role === role && entry.condition === undefined && entry.members.includes(member));
  let iamChanged = false;
  let value!: T;
  let iamRestored = alreadyGranted;
  try {
    if (!alreadyGranted) {
      let binding = next.bindings.find((entry) => entry.role === role && entry.condition === undefined);
      if (!binding) {
        binding = { role, members: [] };
        next.bindings.push(binding);
      }
      binding.members.push(member);
      budget.take('iam');
      await jsonRequest<IamPolicy>(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}:setIamPolicy`,
        { method: 'POST', headers: headers.json, body: JSON.stringify({ policy: next }) },
        'grant temporary cross-service IAM role',
      );
      iamChanged = true;
      await new Promise((resolveWait) => setTimeout(resolveWait, IAM_SETTLE_MS));
    }
    value = await work(iamChanged);
  } finally {
    if (iamChanged) {
      budget.take('iam');
      const current = await jsonRequest<IamPolicy>(
        policyUrl,
        { method: 'POST', headers: headers.json, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) },
        'read IAM policy before restore',
      );
      if (canonicalPolicy(current) !== canonicalPolicy(original)) {
        budget.take('iam');
        await jsonRequest<IamPolicy>(
          `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}:setIamPolicy`,
          { method: 'POST', headers: headers.json, body: JSON.stringify({ policy: { ...original, etag: current.etag } }) },
          'restore original IAM policy',
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, IAM_SETTLE_MS));
      budget.take('iam');
      let finalPolicy = await jsonRequest<IamPolicy>(
        policyUrl,
        { method: 'POST', headers: headers.json, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) },
        'verify settled IAM restoration',
      );
      if (canonicalPolicy(finalPolicy) !== canonicalPolicy(original)) {
        budget.take('iam', 2);
        await jsonRequest<IamPolicy>(
          `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}:setIamPolicy`,
          { method: 'POST', headers: headers.json, body: JSON.stringify({ policy: { ...original, etag: finalPolicy.etag } }) },
          'repeat IAM restoration after propagation drift',
        );
        await new Promise((resolveWait) => setTimeout(resolveWait, IAM_SETTLE_MS));
        finalPolicy = await jsonRequest<IamPolicy>(
          policyUrl,
          { method: 'POST', headers: headers.json, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) },
          'verify repeated IAM restoration',
        );
      }
      iamRestored = canonicalPolicy(finalPolicy) === canonicalPolicy(original);
    }
  }
  if (!iamRestored) throw new Error('IAM restoration verification failed');
  return { value, iamChanged, iamRestored };
}

async function runRemainingCrossService(sa: ServiceAccount, web: WebConfig, secondarySa: ServiceAccount): Promise<void> {
  const headers = await accessHeaders(sa);
  const secondaryHeaders = await accessHeaders(secondarySa);
  const config = await storageConfig(sa, headers);
  if (config.projectId !== web.projectId) throw new Error('Web config and primary probe service account target different projects');
  if (secondarySa.project_id === sa.project_id) throw new Error('secondary probe project must differ from primary project');
  const budget = new RequestBudget({ ...LIMITS });
  const snapshot = await storageRulesSnapshot(sa, config.storageBucket, headers, budget);
  const rulesFile = selectRulesFile(snapshot.ruleset);
  const runId = `r${Date.now().toString(36)}`;
  const prefix = `__pyric_storage_stdlib/${runId}`;
  const source = injectIntoMatch(rulesFile.content, STORAGE_MATCH, '`match /b/{bucket}/o`', crossServiceRules(runId));
  const files = replaceRulesFile(snapshot.ruleset, rulesFile, source);
  await preflightStorageSource(sa, config.storageBucket, headers, budget, files, `${prefix}/compile-canary/preflight.bin`);

  const primaryDocs = {
    iam: firestoreDocumentName(sa.project_id, '(default)', runId, 'iam'),
    consistency: firestoreDocumentName(sa.project_id, '(default)', runId, 'consistency'),
    namedDefault: firestoreDocumentName(sa.project_id, '(default)', runId, 'named'),
    namedProbes: firestoreDocumentName(sa.project_id, 'probes', runId, 'named'),
    isolation: firestoreDocumentName(sa.project_id, '(default)', runId, 'isolation'),
  };
  const secondaryIsolation = firestoreDocumentName(secondarySa.project_id, '(default)', runId, 'isolation');
  const primaryTargets = Object.values(primaryDocs).map((name) => ({ name, headers }));
  const allTargets = [...primaryTargets, { name: secondaryIsolation, headers: secondaryHeaders }];
  const createdObjects = new Set<string>();
  const consistencyBehavior: Record<string, unknown> = {};
  const consistencyDiagnostics: Record<string, unknown> = {};
  const namedBehavior: Record<string, unknown> = {};
  const namedDiagnostics: Record<string, unknown> = {};
  const isolationBehavior: Record<string, unknown> = {};
  const isolationDiagnostics: Record<string, unknown> = {};
  let releaseRestored = false;
  let objectsRemoved = false;
  let documentsRemoved = false;
  let app: ReturnType<typeof initializeApp> | undefined;

  const result = await withTemporaryIam(sa, headers, budget, async () => {
    try {
      await patchDocument(primaryDocs.iam, true, headers, budget);
      await patchDocument(primaryDocs.consistency, false, headers, budget);
      await activateStorageSource(sa, headers, budget, snapshot, files);
      app = initializeApp({ ...web, storageBucket: config.storageBucket }, `storage-stdlib-remaining-${runId}`);
      const storage = getStorage(app);

      const upload = async (family: string, id: string): Promise<Decision> => {
        budget.take('storage');
        const path = `${prefix}/${family}/${id}.bin`;
        try {
          await uploadBytes(storageRef(storage, path), new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]));
          createdObjects.add(path);
          return decision();
        } catch (error) {
          return decision(error);
        }
      };

      let iamCanary = await upload('iam-canary', 'a');
      for (let attempt = 0; !iamCanary.allowed && attempt < IAM_RETRY_LIMIT; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, IAM_RETRY_MS));
        iamCanary = await upload('iam-canary', 'a');
      }
      if (!iamCanary.allowed) throw new Error(`cross-service IAM did not become active: ${iamCanary.code} ${iamCanary.message}`);

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        for (const allow of [true, false]) {
          const writeStartedAt = Date.now();
          const write = await patchDocument(primaryDocs.consistency, allow, headers, budget);
          const requestStartedAt = Date.now();
          const family = allow ? 'consistency-true' : 'consistency-false';
          const immediate = await upload(family, `cycle-${cycle}`);
          const record: Record<string, unknown> = {
            expected: 'ALLOW',
            immediate: immediate.allowed ? 'ALLOW' : 'DENY',
            firestoreUpdateTime: write.updateTime,
            writeToRequestMs: requestStartedAt - writeStartedAt,
            requestMs: Date.now() - requestStartedAt,
          };
          if (!immediate.allowed) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
            const delayed = await upload(family, `cycle-${cycle}`);
            record.delayedAfter2s = delayed.allowed ? 'ALLOW' : 'DENY';
            consistencyDiagnostics[`${family}:cycle-${cycle}`] = { immediate, delayed };
          } else {
            consistencyDiagnostics[`${family}:cycle-${cycle}`] = { immediate };
          }
          consistencyBehavior[`${family}:cycle-${cycle}`] = record;
        }
      }

      await patchDocument(primaryDocs.namedDefault, true, headers, budget);
      await patchDocument(primaryDocs.namedProbes, false, headers, budget);
      await verifyDocument(primaryDocs.namedDefault, true, headers);
      await verifyDocument(primaryDocs.namedProbes, false, headers);
      for (const family of ['named-default', 'named-probes']) {
        const item = await upload(family, 'phase-a');
        namedBehavior[`${family}:default-true-probes-false`] = item.allowed ? 'ALLOW' : 'DENY';
        namedDiagnostics[`${family}:default-true-probes-false`] = item;
      }
      await patchDocument(primaryDocs.namedDefault, false, headers, budget);
      await patchDocument(primaryDocs.namedProbes, true, headers, budget);
      await verifyDocument(primaryDocs.namedDefault, false, headers);
      await verifyDocument(primaryDocs.namedProbes, true, headers);
      for (const family of ['named-default', 'named-probes']) {
        const item = await upload(family, 'phase-b');
        namedBehavior[`${family}:default-false-probes-true`] = item.allowed ? 'ALLOW' : 'DENY';
        namedDiagnostics[`${family}:default-false-probes-true`] = item;
      }

      await patchDocument(primaryDocs.isolation, false, headers, budget);
      await patchDocument(secondaryIsolation, true, secondaryHeaders, budget);
      await verifyDocument(primaryDocs.isolation, false, headers);
      await verifyDocument(secondaryIsolation, true, secondaryHeaders);
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      const isolationA = await upload('isolation', 'primary-false-secondary-true');
      isolationBehavior['primary-false-secondary-true'] = isolationA.allowed ? 'ALLOW' : 'DENY';
      isolationDiagnostics['primary-false-secondary-true'] = isolationA;

      await patchDocument(primaryDocs.isolation, true, headers, budget);
      await patchDocument(secondaryIsolation, false, secondaryHeaders, budget);
      await verifyDocument(primaryDocs.isolation, true, headers);
      await verifyDocument(secondaryIsolation, false, secondaryHeaders);
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      const isolationB = await upload('isolation', 'primary-true-secondary-false');
      isolationBehavior['primary-true-secondary-false'] = isolationB.allowed ? 'ALLOW' : 'DENY';
      isolationDiagnostics['primary-true-secondary-false'] = isolationB;
    } finally {
      await runCleanupSteps([
        { label: 'restore Storage release', run: async () => { releaseRestored = await restoreStorageRelease(headers, budget, snapshot); } },
        { label: 'delete Storage objects', run: async () => { objectsRemoved = await deleteObjects(config.storageBucket, prefix, createdObjects, headers, budget); } },
        { label: 'delete Firestore documents', run: async () => { documentsRemoved = await deleteDocuments(allTargets, budget); } },
        { label: 'delete Firebase app', run: async () => { if (app) await deleteApp(app); } },
      ]);
    }
    return true;
  });

  const cleanup = { releaseRestored, objectsRemoved, documentsRemoved, iamRestored: result.iamRestored };
  if (!Object.values(cleanup).every(Boolean)) throw new Error(`cross-service cleanup failed: ${JSON.stringify(cleanup)}`);
  const iam = { temporaryIam: true, iamChanged: result.iamChanged };
  writeObservations([
    observation(
      'stdlib-realstorage-p3-consistency',
      'Immediate Storage authorization decisions after three true/false Firestore membership transitions, with one bounded delayed confirmation only on an unexpected immediate result.',
      sa.project_id,
      config.storageBucket,
      consistencyBehavior,
      consistencyDiagnostics,
      cleanup,
      budget,
      { iam },
    ),
    observation(
      'stdlib-realstorage-p3-named-database',
      'Default versus existing named `probes` Firestore database lookups with opposite document values and verified fixtures.',
      sa.project_id,
      config.storageBucket,
      namedBehavior,
      namedDiagnostics,
      cleanup,
      budget,
      { iam, namedDatabase: 'probes' },
    ),
    observation(
      'stdlib-realstorage-p3-project-isolation',
      'Storage hosted by digame-mas reading an identical Firestore path whose values are opposite in digame-mas and genkit-idx.',
      sa.project_id,
      config.storageBucket,
      isolationBehavior,
      isolationDiagnostics,
      cleanup,
      budget,
      { iam, secondaryProjectId: secondarySa.project_id },
    ),
  ]);
}

export async function runStorageStdlibRemaining(mode: Mode): Promise<void> {
  if (!process.env.PYRIC_ORACLE_SA_PATH || !process.env.PYRIC_AI_FIREBASE_CONFIG) {
    throw new Error('remaining probes require PYRIC_ORACLE_SA_PATH and PYRIC_AI_FIREBASE_CONFIG');
  }
  const sa = resolveServiceAccount(process.env.PYRIC_ORACLE_SA_PATH);
  const web = JSON.parse(process.env.PYRIC_AI_FIREBASE_CONFIG) as WebConfig;
  if (mode === 'native-fields') return runNativeFields(sa, web);
  if (!process.env.PYRIC_SECONDARY_ORACLE_SA_PATH) {
    throw new Error('remaining cross-service probes require PYRIC_SECONDARY_ORACLE_SA_PATH');
  }
  const secondarySa = resolveServiceAccount(process.env.PYRIC_SECONDARY_ORACLE_SA_PATH);
  return runRemainingCrossService(sa, web, secondarySa);
}
