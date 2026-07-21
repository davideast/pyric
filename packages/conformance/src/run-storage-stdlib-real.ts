#!/usr/bin/env bun
/**
 * Real-resource Storage -> Firestore lookup probe.
 *
 * Unlike projects.test function mocks, this rig deploys a run-scoped Storage
 * match block, writes three run-scoped Firestore documents, and performs real
 * anonymous Storage uploads. The previous Storage release pointer is restored
 * in finally, then every object/document is deleted and absence is verified.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert } from 'firebase-admin/app';
import { deleteApp, initializeApp } from 'firebase/app';
import { getStorage, ref as storageRef, uploadBytes } from 'firebase/storage';

interface ServiceAccount { project_id: string; client_email: string; private_key: string }
interface WebConfig { apiKey: string; projectId: string; appId?: string; authDomain?: string }
interface Release { name: string; rulesetName: string }
interface Ruleset { name: string; source: { files: Array<{ name: string; content: string }> } }
interface IamBinding { role: string; members: string[]; condition?: unknown }
interface IamPolicy { version?: number; etag?: string; bindings?: IamBinding[]; auditConfigs?: unknown[] }

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations', 'storage-rules');
const RULES_API = 'https://firebaserules.googleapis.com/v1';
const FIREBASE_API = 'https://firebase.googleapis.com/v1beta1';

function inert(): void {
  console.log('[storage-stdlib:real] credentials absent — INERT preview; no network calls.');
  console.log('Requires PYRIC_ORACLE_SA_PATH and PYRIC_AI_FIREBASE_CONFIG.');
  console.log('Would create 3 Firestore docs, make 9 Storage upload attempts, restore the prior Storage release, and verify cleanup.');
}

function canonicalPolicy(policy: IamPolicy): string {
  const bindings = (policy.bindings ?? []).map((binding) => ({
    ...binding,
    members: [...binding.members].sort(),
  })).sort((a, b) => `${a.role}:${JSON.stringify(a.condition)}`.localeCompare(`${b.role}:${JSON.stringify(b.condition)}`));
  return JSON.stringify({ version: policy.version ?? 0, bindings, auditConfigs: policy.auditConfigs ?? [] });
}

async function json<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

function injectProbeRules(source: string, runId: string): string {
  const marker = `@pyric/storage-stdlib-real/${runId}`;
  const match = /(match\s+\/b\/\{bucket\}\/o\s*\{)/;
  const found = match.exec(source);
  if (!found) throw new Error('current Storage rules lack canonical `match /b/{bucket}/o` block');
  const insertAt = found.index + found[0].length;
  const block = `
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
  return `${source.slice(0, insertAt)}${block}${source.slice(insertAt)}`;
}

async function run(): Promise<void> {
  if (!process.env.PYRIC_ORACLE_SA_PATH || !process.env.PYRIC_AI_FIREBASE_CONFIG) return inert();

  const saPath = resolve('/home/david/repos/davideast/pyric', process.env.PYRIC_ORACLE_SA_PATH);
  const sa = JSON.parse(readFileSync(saPath, 'utf8')) as ServiceAccount;
  const web = JSON.parse(process.env.PYRIC_AI_FIREBASE_CONFIG) as WebConfig;
  if (web.projectId !== sa.project_id) throw new Error('Web config and oracle service account target different projects');

  const credential = cert(sa as Parameters<typeof cert>[0]);
  const access = await credential.getAccessToken();
  const authHeaders = { Authorization: `Bearer ${access.access_token}` };
  const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };
  const temporaryIam = Bun.argv.includes('--temporary-iam');
  const externallyEnabledIam = Bun.argv.includes('--iam-enabled');
  if (temporaryIam && externallyEnabledIam) {
    throw new Error('--temporary-iam and --iam-enabled are mutually exclusive');
  }
  const expectEnabledIam = temporaryIam || externallyEnabledIam;
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
    let binding = next.bindings.find((entry) => entry.role === role && entry.condition === undefined);
    if (!binding) {
      binding = { role, members: [] };
      next.bindings.push(binding);
    }
    if (!binding.members.includes(member)) {
      binding.members.push(member);
      iamGrantAttempted = true;
      await json<IamPolicy>(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}:setIamPolicy`,
        { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ policy: next }) },
        'grant temporary cross-service IAM role',
      );
      iamChanged = true;
      await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
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

  const app = initializeApp({ ...web, storageBucket: config.storageBucket }, `storage-stdlib-${runId}`);
  const storage = getStorage(app);
  const createdObjects = new Set<string>();
  const docNames = ['a', 'b', 'c'].map((id) => `projects/${sa.project_id}/databases/(default)/documents/__pyric_storage_stdlib/${runId}/docs/${id}`);
  const behavior: Record<string, unknown> = {};
  const diagnostics: Record<string, unknown> = {};
  let probeRulesetName: string | undefined;
  let releaseRestored = false;
  let objectsRemoved = false;
  let documentsRemoved = false;

  const upload = async (family: string, retry = false): Promise<{ allowed: boolean; code?: string; message?: string }> => {
    const path = `${prefix}/${family}/payload.bin`;
    const attempt = async () => {
      try {
        await uploadBytes(storageRef(storage, path), new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]));
        createdObjects.add(path);
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
    for (let i = 0; !last.allowed && i < 20; i += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      last = await attempt();
    }
    return last;
  };

  try {
    for (const docName of docNames) {
      await json(
        `https://firestore.googleapis.com/v1/${docName}`,
        { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ fields: { allow: { booleanValue: true } } }) },
        `create probe document ${docName.split('/').at(-1)}`,
      );
    }

    const probeSource = injectProbeRules(rulesFile.content, runId);
    const created = await json<{ name: string }>(
      `${RULES_API}/projects/${sa.project_id}/rulesets`,
      { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ source: { files: [{ name: rulesFile.name, content: probeSource }] } }) },
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

    for (const family of ['one', 'two', 'three', 'repeat', 'get-exists', 'short', 'missing-exists', 'missing-get']) {
      const result = await upload(family, expectEnabledIam && family === 'one');
      behavior[family] = result.allowed ? 'ALLOW' : 'DENY';
      diagnostics[family] = { code: result.code, message: result.message };
    }
  } finally {
    try {
      await json(
        releaseUrl,
        { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ release: { name: releaseName, rulesetName: original.rulesetName } }) },
        'restore original Storage release',
      );
      const restored = await json<Release>(releaseUrl, { headers: authHeaders }, 'verify restored Storage release');
      releaseRestored = restored.rulesetName === original.rulesetName;
    } finally {
      for (const objectPath of createdObjects) {
        const response = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.storageBucket)}/o/${encodeURIComponent(objectPath)}`, { method: 'DELETE', headers: authHeaders });
        if (!response.ok && response.status !== 404) throw new Error(`delete probe object failed: ${response.status} ${await response.text()}`);
      }
      const list = await json<{ items?: unknown[] }>(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.storageBucket)}/o?prefix=${encodeURIComponent(prefix)}`,
        { headers: authHeaders }, 'verify probe object cleanup',
      );
      objectsRemoved = (list.items?.length ?? 0) === 0;

      for (const docName of docNames) {
        const response = await fetch(`https://firestore.googleapis.com/v1/${docName}`, { method: 'DELETE', headers: authHeaders });
        if (!response.ok && response.status !== 404) throw new Error(`delete probe document failed: ${response.status} ${await response.text()}`);
      }
      const checks = await Promise.all(docNames.map((docName) => fetch(`https://firestore.googleapis.com/v1/${docName}`, { headers: authHeaders })));
      documentsRemoved = checks.every((response) => response.status === 404);
      await deleteApp(app);
    }
  }

  if (!releaseRestored || !objectsRemoved || !documentsRemoved) {
    throw new Error(`cleanup verification failed: releaseRestored=${releaseRestored} objectsRemoved=${objectsRemoved} documentsRemoved=${documentsRemoved}`);
  }

  completedObservation = {
    name: expectEnabledIam
      ? 'stdlib-realstorage-p3-lookup-budget-iam-enabled'
      : 'stdlib-realstorage-p3-lookup-budget',
    matrixRow: '',
    rowIds: [],
    description: 'Real-resource Storage-to-Firestore lookup behavior for one/two/three distinct documents, repeated paths, get+exists composition, short-circuiting, and missing documents. The rig restores the exact prior Storage release and verifies all run-scoped data is absent before writing this file.',
    observedAt: new Date().toISOString(),
    fbSdkVersion: (JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('firebase/package.json')), 'utf8')) as { version: string }).version,
    projectId: sa.project_id,
    bucket: config.storageBucket,
    behavior,
    diagnostics,
    cleanup: { releaseRestored, objectsRemoved, documentsRemoved, iamRestored: !temporaryIam },
    iam: { temporaryIam, externallyEnabledIam, iamChanged },
    probeRulesetCreated: !!probeRulesetName,
  };
  } finally {
    if (temporaryIam && originalIam && iamGrantAttempted) {
      const policyUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}:getIamPolicy`;
      const currentPolicy = await json<IamPolicy>(
        policyUrl,
        { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) },
        'read IAM policy before restore',
      );
      if (canonicalPolicy(currentPolicy) !== canonicalPolicy(originalIam)) {
        const restore = { ...originalIam, etag: currentPolicy.etag };
        await json<IamPolicy>(
          `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}:setIamPolicy`,
          { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ policy: restore }) },
          'restore original IAM policy',
        );
      }
      const finalPolicy = await json<IamPolicy>(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${sa.project_id}:getIamPolicy`,
        { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) },
        'verify restored IAM policy',
      );
      iamRestored = canonicalPolicy(finalPolicy) === canonicalPolicy(originalIam);
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

if (import.meta.main) await run();
