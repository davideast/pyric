#!/usr/bin/env bun
/**
 * Real-resource Storage -> Firestore lookup probe.
 *
 * Unlike projects.test function mocks, this rig deploys a run-scoped Storage
 * match block, writes three run-scoped Firestore documents, and performs real
 * anonymous Storage uploads. The previous Storage release pointer is restored
 * in finally, then every object/document is deleted and absence is verified.
 * Additional explicit modes cover native object fields and the remaining
 * cross-service database/project boundaries through the same exclusive lock.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteApp, initializeApp } from 'firebase/app';
import { getStorage, ref as storageRef, uploadBytes } from 'firebase/storage';
import { readObservationLinkage } from './observation-linkage.ts';
import {
  accessHeaders,
  FIREBASE_API,
  jsonRequest as rawJson,
  resolveServiceAccount,
  RULES_API,
  type WebConfig,
} from './storage-stdlib-real-api.ts';
import {
  RequestBudget,
  STORAGE_CLEANUP_LIMITS,
  STORAGE_PROBE_LIMITS,
  runCleanupSteps,
  storageProbeRequestKind,
} from './storage-stdlib-real-budget.ts';
import {
  restoreIamPolicy,
  type IamPolicy,
} from './storage-stdlib-real-iam.ts';
import { acquireRunLock } from './storage-stdlib-real-lock.ts';
import {
  deleteStorageObjects,
} from './storage-stdlib-real-objects.ts';
import {
  restoreRulesRelease,
  type Release,
  type Ruleset,
} from './storage-stdlib-real-rules.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations', 'storage-rules');
const IAM_SETTLE_MS = 120_000;
const IAM_RETRY_MS = 30_000;
const IAM_RETRY_LIMIT = 6;
function inert(): void {
  console.log('[storage-stdlib:real] credentials absent — INERT preview; no network calls.');
  console.log('Requires PYRIC_ORACLE_SA_PATH and PYRIC_AI_FIREBASE_CONFIG.');
  console.log('Would evaluate the selected bounded Storage matrix, restore prior Rules releases/IAM, and verify run-scoped cleanup.');
}

export function injectProbeRules(source: string, runId: string, advanced: boolean): string {
  const marker = `@pyric/storage-stdlib-real/${runId}`;
  const match = /(match\s+\/b\/\{bucket\}\/o\s*\{)/;
  const found = match.exec(source);
  if (!found) throw new Error('current Storage rules lack canonical `match /b/{bucket}/o` block');
  const insertAt = found.index + found[0].length;
  const coreBlock = `
    // ${marker}
    match /__pyric_storage_stdlib/${runId}/canary/{id} {
      allow create: if true;
    }
    match /__pyric_storage_stdlib/${runId}/one/{id} {
      allow create: if firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a);
    }
    match /__pyric_storage_stdlib/${runId}/two/{id} {
      allow create: if firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a)
        && firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/b);
    }
    match /__pyric_storage_stdlib/${runId}/three/{id} {
      allow create: if firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a)
        && firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/b)
        && firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/c);
    }
    match /__pyric_storage_stdlib/${runId}/repeat/{id} {
      allow create: if firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a)
        && firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a)
        && firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a);
    }
    match /__pyric_storage_stdlib/${runId}/get-exists/{id} {
      allow create: if firestore.get(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a).data.allow == true
        && firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a)
        && firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/b);
    }
    match /__pyric_storage_stdlib/${runId}/short/{id} {
      allow create: if true || (
        firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a)
        && firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/b)
        && firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/c)
      );
    }
    match /__pyric_storage_stdlib/${runId}/missing-exists/{id} {
      allow create: if !firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/missing);
    }
    match /__pyric_storage_stdlib/${runId}/missing-get/{id} {
      allow create: if firestore.get(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/missing).data.allow == true;
    }
`;
  const advancedBlock = `
    // ${marker}
    function lookupA() {
      return firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a);
    }
    function letLookupA() {
      let doc = firestore.get(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a);
      return doc.data.allow == true;
    }
    match /__pyric_storage_stdlib/${runId}/canary/{id} {
      allow create: if true;
    }
    match /__pyric_storage_stdlib/${runId}/existing-get/{id} {
      allow create: if firestore.get(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a).data.allow == true;
    }
    match /__pyric_storage_stdlib/${runId}/absent-field/{id} {
      allow create: if firestore.get(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a).data.missing == null;
    }
    match /__pyric_storage_stdlib/${runId}/wrong-type/{id} {
      allow create: if firestore.get(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a).data.count == '7';
    }
    match /__pyric_storage_stdlib/${runId}/nested-map/{id} {
      allow create: if firestore.get(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a).data.nested.flag == true;
    }
    match /__pyric_storage_stdlib/${runId}/list-membership/{id} {
      allow create: if 'beta' in firestore.get(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/a).data.tags;
    }
    match /__pyric_storage_stdlib/${runId}/auth-interpolation/{id} {
      allow create: if firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/$(request.auth.uid));
    }
    match /__pyric_storage_stdlib/${runId}/named-database/{id} {
      allow create: if firestore.exists(/databases/named/documents/__pyric_storage_stdlib/${runId}/docs/a);
    }
    match /__pyric_storage_stdlib/${runId}/false-or/{id} {
      allow create: if false || lookupA();
    }
    match /__pyric_storage_stdlib/${runId}/true-ternary/{id} {
      allow create: if true ? lookupA() : firestore.exists(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/b);
    }
    match /__pyric_storage_stdlib/${runId}/helper/{id} {
      allow create: if lookupA();
    }
    match /__pyric_storage_stdlib/${runId}/let-binding/{id} {
      allow create: if letLookupA();
    }
    match /__pyric_storage_stdlib/${runId}/error-or-true/{id} {
      allow create: if firestore.get(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/missing).data.allow == true || true;
    }
    match /__pyric_storage_stdlib/${runId}/false-and-error/{id} {
      allow create: if false && firestore.get(/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/missing).data.allow == true;
    }
    match /__pyric_storage_stdlib/${runId}/firestore-deny-rules/{id} {
      allow create: if lookupA();
    }
    match /__pyric_storage_stdlib/${runId}/firestore-allow-rules/{id} {
      allow create: if lookupA();
    }
`;
  const block = advanced ? advancedBlock : coreBlock;
  return `${source.slice(0, insertAt)}${block}${source.slice(insertAt)}`;
}

export function storageStdlibRealProbeBlockDigest(advanced: boolean): string {
  const canonical = injectProbeRules(
    "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { } }",
    '__RUN_ID__',
    advanced,
  );
  return createHash('sha256').update(canonical).digest('hex');
}

function injectFirestoreProbeRule(source: string, runId: string, allow: boolean): string {
  const match = /(match\s+\/databases\/\{database\}\/documents\s*\{)/;
  const found = match.exec(source);
  if (!found) throw new Error('current Firestore rules lack canonical `match /databases/{database}/documents` block');
  const insertAt = found.index + found[0].length;
  const block = `
    match /__pyric_storage_stdlib/${runId}/docs/{id} {
      allow get: if ${allow};
    }
`;
  return `${source.slice(0, insertAt)}${block}${source.slice(insertAt)}`;
}

async function run(): Promise<void> {
  if (!process.env.PYRIC_ORACLE_SA_PATH || !process.env.PYRIC_AI_FIREBASE_CONFIG) return inert();
  if (Bun.argv.includes('--native-fields') || Bun.argv.includes('--remaining-cross-service')) {
    const { runStorageStdlibRemaining } = await import('./run-storage-stdlib-remaining.ts');
    return runStorageStdlibRemaining(Bun.argv.includes('--native-fields') ? 'native-fields' : 'remaining-cross-service');
  }

  const sa = resolveServiceAccount(process.env.PYRIC_ORACLE_SA_PATH);
  const web = JSON.parse(process.env.PYRIC_AI_FIREBASE_CONFIG) as WebConfig;
  if (web.projectId !== sa.project_id) throw new Error('Web config and oracle service account target different projects');

  const { auth: authHeaders, json: jsonHeaders } = await accessHeaders(sa);
  const budget = new RequestBudget({ ...STORAGE_PROBE_LIMITS });
  const cleanupBudget = new RequestBudget({ ...STORAGE_CLEANUP_LIMITS });
  const json = async <T>(url: string, init: RequestInit, label: string): Promise<T> => {
    budget.take(storageProbeRequestKind(url));
    return rawJson<T>(url, init, label);
  };
  const cleanupJson = async <T>(url: string, init: RequestInit, label: string): Promise<T> => {
    cleanupBudget.take(storageProbeRequestKind(url));
    return rawJson<T>(url, init, label);
  };
  const temporaryIam = Bun.argv.includes('--temporary-iam');
  const externallyEnabledIam = Bun.argv.includes('--iam-enabled');
  const compileAdvanced = Bun.argv.includes('--compile-advanced');
  const advanced = Bun.argv.includes('--advanced') || compileAdvanced;
  if (temporaryIam && externallyEnabledIam) {
    throw new Error('--temporary-iam and --iam-enabled are mutually exclusive');
  }
  const expectEnabledIam = temporaryIam || externallyEnabledIam;
  if (advanced && !expectEnabledIam && !compileAdvanced) {
    throw new Error('--advanced requires --temporary-iam or --iam-enabled');
  }
  let originalIam: IamPolicy | undefined;
  let iamChanged = false;
  let iamGrantAttempted = false;
  let iamRestored = !temporaryIam;
  let completedObservation: Record<string, unknown> | undefined;

  try {
  if (temporaryIam) {
    const project = await json<{ projectNumber: string }>(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}`,
      { headers: authHeaders }, 'read project number',
    );
    const policyUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}:getIamPolicy`;
    originalIam = await json<IamPolicy>(
      policyUrl,
      { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) },
      'snapshot IAM policy',
    );
    const role = 'roles/firebaserules.firestoreServiceAgent';
    const member = `serviceAccount:service-${project.projectNumber}@gcp-sa-firebasestorage.iam.gserviceaccount.com`;
    const next = structuredClone(originalIam);
    next.version = Math.max(next.version ?? 0, 3);
    next.bindings ??= [];
    const alreadyGranted = next.bindings.some((entry) => entry.role === role
      && entry.condition === undefined
      && entry.members.includes(member));
    if (!alreadyGranted) {
      let binding = next.bindings.find((entry) => entry.role === role && entry.condition === undefined);
      if (!binding) {
        binding = { role, members: [] };
        next.bindings.push(binding);
      }
      binding.members.push(member);
      iamGrantAttempted = true;
      await json<IamPolicy>(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}:setIamPolicy`,
        { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ policy: next }) },
        'grant temporary cross-service IAM role',
      );
      iamChanged = true;
      await new Promise((resolveWait) => setTimeout(resolveWait, IAM_SETTLE_MS));
    }
  }
  const config = await json<{ storageBucket: string; projectId: string }>(
    `${FIREBASE_API}/projects/${sa.project_id}/adminSdkConfig`, { headers: authHeaders }, 'read Admin SDK config',
  );
  if (!config.storageBucket) throw new Error('oracle project has no Storage bucket');

  const runId = `r${Date.now().toString(36)}`;
  const prefix = `__pyric_storage_stdlib/${runId}`;
  const releaseName = `projects/${sa.project_id}/releases/firebase.storage/${config.storageBucket}`;
  const releaseUrl = `${RULES_API}/${releaseName}`;
  const original = await json<Release>(releaseUrl, { headers: authHeaders }, 'snapshot Storage release');
  const originalRuleset = await json<Ruleset>(`${RULES_API}/${original.rulesetName}`, { headers: authHeaders }, 'snapshot Storage ruleset');
  const rulesFile = originalRuleset.source.files.find((file) => file.name.endsWith('.rules')) ?? originalRuleset.source.files[0];
  if (!rulesFile) throw new Error('current Storage ruleset has no source file');
  if (compileAdvanced) {
    const runId = 'compile';
    const content = injectProbeRules(rulesFile.content, runId, true);
    const files = originalRuleset.source.files.map((file) => file === rulesFile ? { ...file, content } : file);
    budget.take('rules');
    const response = await fetch(`${RULES_API}/projects/${sa.project_id}:test`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        source: { files },
        testSuite: {
          testCases: [{
            expectation: 'ALLOW',
            request: {
              method: 'create',
              path: `/b/${config.storageBucket}/o/__pyric_storage_stdlib/${runId}/canary/x`,
              resource: { size: 5 },
            },
          }],
        },
      }),
    });
    const result = await response.json() as { issues?: unknown[]; testResults?: Array<{ state?: string }>; error?: unknown };
    if (!response.ok || result.issues?.length || result.error) {
      throw new Error(`advanced Storage source preflight failed: ${response.status} ${JSON.stringify(result)}`);
    }
    console.log(`[storage-stdlib:real] advanced source preflight ${result.testResults?.[0]?.state ?? 'UNKNOWN'}; no mutations.`);
    return;
  }
  const firestoreReleaseName = `projects/${sa.project_id}/releases/cloud.firestore`;
  const firestoreReleaseUrl = `${RULES_API}/${firestoreReleaseName}`;
  const originalFirestore = advanced
    ? await json<Release>(firestoreReleaseUrl, { headers: authHeaders }, 'snapshot Firestore release')
    : undefined;
  const originalFirestoreRuleset = originalFirestore
    ? await json<Ruleset>(`${RULES_API}/${originalFirestore.rulesetName}`, { headers: authHeaders }, 'snapshot Firestore ruleset')
    : undefined;
  const firestoreRulesFile = originalFirestoreRuleset?.source.files.find((file) => file.name.endsWith('.rules'))
    ?? originalFirestoreRuleset?.source.files[0];
  if (advanced && !firestoreRulesFile) throw new Error('current Firestore ruleset has no source file');

  const app = initializeApp({ ...web, storageBucket: config.storageBucket }, `storage-stdlib-${runId}`);
  const storage = getStorage(app);
  const createdObjects = new Set<string>();
  const docNames = ['a', 'b', 'c'].map((id) => `projects/${sa.project_id}/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/${id}`);
  const behavior: Record<string, unknown> = {};
  const diagnostics: Record<string, unknown> = {};
  let probeRulesetName: string | undefined;
  let releaseRestored = false;
  let firestoreReleaseRestored = !advanced;
  let objectsRemoved = false;
  let documentsRemoved = false;

  const upload = async (family: string, retry = false): Promise<{ allowed: boolean; code?: string; message?: string }> => {
    const path = `${prefix}/${family}/payload.bin`;
    createdObjects.add(path);
    const attempt = async () => {
      budget.take('storage');
      try {
        await uploadBytes(storageRef(storage, path), new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]));
        return { allowed: true };
      } catch (error) {
        return {
          allowed: false,
          code: (error as { code?: string }).code,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    };
    if (!retry) return attempt();
    let last = await attempt();
    for (let i = 0; !last.allowed && i < IAM_RETRY_LIMIT; i += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, IAM_RETRY_MS));
      last = await attempt();
    }
    return last;
  };

  const activateFirestoreProbeRule = async (allow: boolean): Promise<number> => {
    if (!originalFirestoreRuleset || !firestoreRulesFile) throw new Error('Firestore rules snapshot unavailable');
    const content = injectFirestoreProbeRule(firestoreRulesFile.content, runId, allow);
    const files = originalFirestoreRuleset.source.files.map((file) => file === firestoreRulesFile ? { ...file, content } : file);
    const created = await json<{ name: string }>(
      `${RULES_API}/projects/${sa.project_id}/rulesets`,
      { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ source: { files } }) },
      `create ${allow ? 'allow' : 'deny'} probe Firestore ruleset`,
    );
    await json(
      firestoreReleaseUrl,
      { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ release: { name: firestoreReleaseName, rulesetName: created.name } }) },
      `activate ${allow ? 'allow' : 'deny'} probe Firestore ruleset`,
    );
    const expected = allow ? 200 : 403;
    const documentUrl = `https://firestore.googleapis.com/v1/${docNames[0]}?key=${encodeURIComponent(web.apiKey)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      budget.take('firestoreWrite');
      const response = await fetch(documentUrl);
      if (response.status === expected) return response.status;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    }
    throw new Error(`probe Firestore rules did not reach expected anonymous status ${expected}`);
  };

  try {
    for (const [index, docName] of docNames.entries()) {
      const fields = index === 0 ? {
        allow: { booleanValue: true },
        count: { integerValue: '7' },
        nested: { mapValue: { fields: { flag: { booleanValue: true } } } },
        tags: { arrayValue: { values: [{ stringValue: 'alpha' }, { stringValue: 'beta' }] } },
      } : { allow: { booleanValue: true } };
      await json(
        `https://firestore.googleapis.com/v1/${docName}`,
        { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ fields }) },
        `create probe document ${docName.split('/').at(-1)}`,
      );
    }

    const probeSource = injectProbeRules(rulesFile.content, runId, advanced);
    const probeFiles = originalRuleset.source.files.map((file) => file === rulesFile ? { ...file, content: probeSource } : file);
    const created = await json<{ name: string }>(
      `${RULES_API}/projects/${sa.project_id}/rulesets`,
      { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ source: { files: probeFiles } }) },
      'create probe Storage ruleset',
    );
    probeRulesetName = created.name;
    await json(
      releaseUrl,
      { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ release: { name: releaseName, rulesetName: created.name } }) },
      'activate probe Storage ruleset',
    );

    const canary = await upload('canary', true);
    if (!canary.allowed) throw new Error(`probe rules did not become active: ${canary.code} ${canary.message}`);

    const families = advanced
      ? ['existing-get', 'absent-field', 'wrong-type', 'nested-map', 'list-membership', 'auth-interpolation', 'named-database', 'false-or', 'true-ternary', 'helper', 'let-binding', 'error-or-true', 'false-and-error']
      : ['one', 'two', 'three', 'repeat', 'get-exists', 'short', 'missing-exists', 'missing-get'];
    for (const family of families) {
      const result = await upload(family, expectEnabledIam && family === (advanced ? 'existing-get' : 'one'));
      behavior[family] = result.allowed ? 'ALLOW' : 'DENY';
      diagnostics[family] = { code: result.code, message: result.message };
    }
    if (advanced) {
      behavior['firestore-client-deny-control'] = await activateFirestoreProbeRule(false) === 403 ? 'DENY' : 'UNEXPECTED';
      const deniedRules = await upload('firestore-deny-rules');
      behavior['firestore-deny-rules'] = deniedRules.allowed ? 'ALLOW' : 'DENY';
      diagnostics['firestore-deny-rules'] = { code: deniedRules.code, message: deniedRules.message };
      behavior['firestore-client-allow-control'] = await activateFirestoreProbeRule(true) === 200 ? 'ALLOW' : 'UNEXPECTED';
      const allowedRules = await upload('firestore-allow-rules');
      behavior['firestore-allow-rules'] = allowedRules.allowed ? 'ALLOW' : 'DENY';
      diagnostics['firestore-allow-rules'] = { code: allowedRules.code, message: allowedRules.message };
    }
  } finally {
    await runCleanupSteps([
      {
        label: 'restore Firestore release',
        run: async () => {
          if (!originalFirestore) return;
          firestoreReleaseRestored = await restoreRulesRelease(
            { auth: authHeaders, json: jsonHeaders },
            cleanupBudget,
            firestoreReleaseUrl,
            firestoreReleaseName,
            originalFirestore.rulesetName,
            (url, init, label) => rawJson<Release>(url, init, label),
          );
        },
      },
      {
        label: 'restore Storage release',
        run: async () => {
          releaseRestored = await restoreRulesRelease(
            { auth: authHeaders, json: jsonHeaders },
            cleanupBudget,
            releaseUrl,
            releaseName,
            original.rulesetName,
            (url, init, label) => rawJson<Release>(url, init, label),
          );
        },
      },
      {
        label: 'delete Storage objects',
        run: async () => {
          objectsRemoved = await deleteStorageObjects(
            config.storageBucket,
            prefix,
            createdObjects,
            { auth: authHeaders, json: jsonHeaders },
            cleanupBudget,
          );
        },
      },
      ...docNames.map((docName) => ({
        label: `delete probe document ${docName}`,
        run: async () => {
          cleanupBudget.take('firestoreWrite');
          const response = await fetch(`https://firestore.googleapis.com/v1/${docName}`, { method: 'DELETE', headers: authHeaders });
          if (!response.ok && response.status !== 404) throw new Error(`delete probe document failed: ${response.status} ${await response.text()}`);
        },
      })),
      {
        label: 'verify probe document cleanup',
        run: async () => {
          cleanupBudget.take('firestoreWrite', docNames.length);
          const checks = await Promise.all(docNames.map((docName) => fetch(`https://firestore.googleapis.com/v1/${docName}`, { headers: authHeaders })));
          documentsRemoved = checks.every((response) => response.status === 404);
        },
      },
      { label: 'delete Firebase app', run: async () => deleteApp(app) },
    ]);
  }

  if (!releaseRestored || !firestoreReleaseRestored || !objectsRemoved || !documentsRemoved) {
    throw new Error(`cleanup verification failed: releaseRestored=${releaseRestored} firestoreReleaseRestored=${firestoreReleaseRestored} objectsRemoved=${objectsRemoved} documentsRemoved=${documentsRemoved}`);
  }

  const observationName = advanced
      ? 'stdlib-realstorage-p3-advanced-iam-enabled'
      : expectEnabledIam
      ? 'stdlib-realstorage-p3-lookup-budget-iam-enabled'
      : 'stdlib-realstorage-p3-lookup-budget';
  const linkage = readObservationLinkage(join(OBS_DIR, `${observationName}.json`));
  completedObservation = {
    name: observationName,
    matrixRow: linkage.matrixRow,
    rowIds: linkage.rowIds,
    description: advanced
      ? 'Real-resource Storage-to-Firestore advanced behavior for return types, evaluation order, path boundaries, helper composition, and independence from the Firestore ruleset.'
      : 'Real-resource Storage-to-Firestore lookup behavior for one/two/three distinct documents, repeated paths, get+exists composition, short-circuiting, and missing documents.',
    observedAt: new Date().toISOString(),
    fbSdkVersion: (JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('firebase/package.json')), 'utf8')) as { version: string }).version,
    projectId: sa.project_id,
    bucket: config.storageBucket,
    behavior,
    diagnostics,
    cleanup: { releaseRestored, firestoreReleaseRestored, objectsRemoved, documentsRemoved, iamRestored: !temporaryIam },
    iam: { temporaryIam, externallyEnabledIam, iamChanged },
    requestBudget: budget.snapshot(),
    cleanupRequestBudget: cleanupBudget.snapshot(),
    probeBlockSha256: storageStdlibRealProbeBlockDigest(advanced),
    deployedRulesFileSha256: createHash('sha256')
      .update(injectProbeRules(rulesFile.content, runId, advanced)).digest('hex'),
    probeRulesetCreated: !!probeRulesetName,
  };
  } finally {
    if (temporaryIam && originalIam && iamGrantAttempted) {
      const policyUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}:getIamPolicy`;
      iamRestored = await restoreIamPolicy(
        policyUrl,
        originalIam,
        { auth: authHeaders, json: jsonHeaders },
        (url, init, label) => cleanupJson<IamPolicy>(url, init, label),
        async () => { await new Promise((resolveWait) => setTimeout(resolveWait, IAM_SETTLE_MS)); },
      );
    } else if (temporaryIam) {
      iamRestored = true;
    }
  }

  if (!completedObservation) throw new Error('probe completed without an observation payload');
  const cleanup = completedObservation.cleanup as { releaseRestored: boolean; objectsRemoved: boolean; documentsRemoved: boolean; iamRestored: boolean };
  cleanup.iamRestored = iamRestored;
  if (!iamRestored) throw new Error('IAM cleanup verification failed');
  mkdirSync(OBS_DIR, { recursive: true });
  const path = join(OBS_DIR, `${completedObservation.name}.json`);
  writeFileSync(path, `${JSON.stringify(completedObservation, null, 2)}\n`);
  console.log(`[storage-stdlib:real] capture complete; cleanup verified; wrote ${path}`);
}

if (import.meta.main) {
  const releaseLock = acquireRunLock();
  try {
    await run();
  } finally {
    releaseLock();
  }
}
