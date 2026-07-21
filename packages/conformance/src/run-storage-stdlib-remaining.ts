import { deleteApp, initializeApp } from 'firebase/app';
import { createHash } from 'node:crypto';
import { getStorage, ref as storageRef, uploadBytes } from 'firebase/storage';
import {
  RequestBudget,
  STORAGE_MATCH,
  STORAGE_PROBE_LIMITS,
  accessHeaders,
  activateStorageSource,
  canonicalPolicy,
  deleteStorageObjects,
  firestoreDocumentName,
  injectIntoMatch,
  jsonRequest,
  preflightStorageSource,
  replaceRulesFile,
  resolveServiceAccount,
  restoreStorageRelease,
  runCleanupSteps,
  selectRulesFile,
  storageConfig,
  storageDecision,
  storageObservation,
  storageRulesSnapshot,
  writeStorageObservations,
  type AccessHeaders,
  type IamPolicy,
  type ServiceAccount,
  type StorageDecision,
  type WebConfig,
} from './storage-stdlib-real-support.ts';

type Mode = 'native-fields' | 'remaining-cross-service';

const IAM_SETTLE_MS = 120_000;
const IAM_RETRY_MS = 30_000;
const IAM_RETRY_LIMIT = 6;

export function crossServiceRules(runId: string): string {
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

export function storageStdlibRemainingProbeBlockDigest(): string {
  return createHash('sha256').update(crossServiceRules('__RUN_ID__')).digest('hex');
}

async function patchDocument(name: string, allow: boolean, headers: AccessHeaders, budget: RequestBudget): Promise<{ updateTime?: string }> {
  budget.take('firestoreWrite');
  return jsonRequest(
    `https://firestore.googleapis.com/v1/${name}`,
    { method: 'PATCH', headers: headers.json, body: JSON.stringify({ fields: { allow: { booleanValue: allow } } }) },
    `write probe document ${name}`,
  );
}

async function verifyDocument(name: string, allow: boolean, headers: AccessHeaders): Promise<void> {
  const document = await jsonRequest<{ fields?: { allow?: { booleanValue?: boolean } } }>(
    `https://firestore.googleapis.com/v1/${name}`,
    { headers: headers.auth },
    `verify probe document ${name}`,
  );
  if (document.fields?.allow?.booleanValue !== allow) throw new Error(`probe document ${name} did not contain allow=${allow}`);
}

async function deleteDocuments(targets: Array<{ name: string; headers: AccessHeaders }>, budget: RequestBudget): Promise<boolean> {
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
  headers: AccessHeaders,
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
  const budget = new RequestBudget({ ...STORAGE_PROBE_LIMITS });
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

      const upload = async (family: string, id: string): Promise<StorageDecision> => {
        budget.take('storage');
        const path = `${prefix}/${family}/${id}.bin`;
        try {
          await uploadBytes(storageRef(storage, path), new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]));
          createdObjects.add(path);
          return storageDecision();
        } catch (error) {
          return storageDecision(error);
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
        { label: 'delete Storage objects', run: async () => { objectsRemoved = await deleteStorageObjects(config.storageBucket, prefix, createdObjects, headers, budget); } },
        { label: 'delete Firestore documents', run: async () => { documentsRemoved = await deleteDocuments(allTargets, budget); } },
        { label: 'delete Firebase app', run: async () => { if (app) await deleteApp(app); } },
      ]);
    }
    return true;
  });

  const cleanup = { releaseRestored, objectsRemoved, documentsRemoved, iamRestored: result.iamRestored };
  if (!Object.values(cleanup).every(Boolean)) throw new Error(`cross-service cleanup failed: ${JSON.stringify(cleanup)}`);
  const iam = { temporaryIam: true, iamChanged: result.iamChanged };
  writeStorageObservations([
    storageObservation(
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
    storageObservation(
      'stdlib-realstorage-p3-named-database',
      'Default versus existing named `probes` Firestore database lookups with opposite document values and verified fixtures.',
      sa.project_id,
      config.storageBucket,
      namedBehavior,
      namedDiagnostics,
      cleanup,
      budget,
      {
        iam,
        namedDatabase: 'probes',
        probeBlockSha256: storageStdlibRemainingProbeBlockDigest(),
        deployedRulesFileSha256: createHash('sha256').update(source).digest('hex'),
      },
    ),
    storageObservation(
      'stdlib-realstorage-p3-project-isolation',
      'Storage hosted by digame-mas reading an identical Firestore path whose values are opposite in digame-mas and genkit-idx.',
      sa.project_id,
      config.storageBucket,
      isolationBehavior,
      isolationDiagnostics,
      cleanup,
      budget,
      {
        iam,
        secondaryProjectId: secondarySa.project_id,
        probeBlockSha256: storageStdlibRemainingProbeBlockDigest(),
        deployedRulesFileSha256: createHash('sha256').update(source).digest('hex'),
      },
    ),
  ]);
}

export async function runStorageStdlibRemaining(mode: Mode): Promise<void> {
  if (!process.env.PYRIC_ORACLE_SA_PATH || !process.env.PYRIC_AI_FIREBASE_CONFIG) {
    throw new Error('remaining probes require PYRIC_ORACLE_SA_PATH and PYRIC_AI_FIREBASE_CONFIG');
  }
  const sa = resolveServiceAccount(process.env.PYRIC_ORACLE_SA_PATH);
  const web = JSON.parse(process.env.PYRIC_AI_FIREBASE_CONFIG) as WebConfig;
  if (mode === 'native-fields') {
    const { runStorageStdlibNativeFields } = await import('./run-storage-stdlib-native-fields.ts');
    return runStorageStdlibNativeFields(sa, web);
  }
  if (!process.env.PYRIC_SECONDARY_ORACLE_SA_PATH) {
    throw new Error('remaining cross-service probes require PYRIC_SECONDARY_ORACLE_SA_PATH');
  }
  const secondarySa = resolveServiceAccount(process.env.PYRIC_SECONDARY_ORACLE_SA_PATH);
  return runRemainingCrossService(sa, web, secondarySa);
}
