import {
  RULES_API,
  jsonRequest,
  type AccessHeaders,
  type ServiceAccount,
} from './storage-stdlib-real-api.ts';

export interface FirestoreRulesFile { name: string; content: string }
export interface FirestoreRuleset {
  name: string;
  source: { files: FirestoreRulesFile[] };
}
export interface FirestoreRelease { name: string; rulesetName: string }

const FIRESTORE_DOCUMENTS_MATCH =
  /(match\s+\/databases\/\{database\}\/documents\s*\{)/;

export function hostedTestApiDiagnostics(value: unknown): unknown {
  let current = value;
  while (current && typeof current === 'object' &&
      'hostedTestApiLimitation' in current) {
    current = (current as { hostedTestApiLimitation: unknown }).hostedTestApiLimitation;
  }
  return current;
}

export function selectFirestoreRulesFile(
  ruleset: FirestoreRuleset,
): FirestoreRulesFile {
  const selected = ruleset.source.files.find((file) =>
    file.content.includes('service cloud.firestore')
  )
    ?? ruleset.source.files[0];
  if (!selected) throw new Error('current Firestore ruleset has no source file');
  return selected;
}

export function injectFirestoreProbeRules(source: string, runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('unsafe Firestore probe run id');
  const found = FIRESTORE_DOCUMENTS_MATCH.exec(source);
  if (!found) {
    throw new Error(
      'current rules lack canonical `match /databases/{database}/documents` block',
    );
  }
  const insertAt = found.index + found[0].length;
  const block = `
    match /__pyric_firestore_cdd/${runId}/retry {
      allow read, write: if request.auth != null;
    }
    match /__pyric_firestore_cdd/${runId}/exhausted {
      allow read, write: if request.auth != null;
    }
    match /__pyric_firestore_cdd/${runId}/browser/{document=**} {
      allow read, write: if request.auth != null;
    }
    match /__pyric_firestore_cdd/${runId}/rules_get_after/{caseId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
        && caseId == 'target_allow'
        && getAfter(request.path).data.x == request.resource.data.x;
      allow create: if request.auth != null
        && caseId == 'exists_create'
        && existsAfter(request.path);
      allow delete: if request.auth != null
        && caseId == 'exists_delete'
        && !existsAfter(request.path);
      allow create: if request.auth != null
        && caseId == 'exists_unrelated'
        && existsAfter(/databases/$(database)/documents/__pyric_firestore_cdd/${runId}/rules_get_after/companion);
      allow create: if request.auth != null
        && caseId == 'wrong_exists_create'
        && !existsAfter(request.path);
      allow create, update: if request.auth != null
        && caseId == 'primary'
        && getAfter(/databases/$(database)/documents/__pyric_firestore_cdd/${runId}/rules_get_after/companion).data.count
          == get(/databases/$(database)/documents/__pyric_firestore_cdd/${runId}/rules_get_after/companion).data.count + 1;
      allow create, update: if request.auth != null && caseId == 'companion';
    }
`;
  return `${source.slice(0, insertAt)}${block}${source.slice(insertAt)}`;
}

export function replaceSelectedRulesFile(
  ruleset: FirestoreRuleset,
  selected: FirestoreRulesFile,
  content: string,
): FirestoreRulesFile[] {
  return ruleset.source.files.map((file) =>
    file === selected ? { ...file, content } : file
  );
}

export async function snapshotFirestoreRules(
  sa: ServiceAccount,
  headers: AccessHeaders,
): Promise<{
  release: FirestoreRelease;
  ruleset: FirestoreRuleset;
  releaseName: string;
  releaseUrl: string;
}> {
  const releaseName = `projects/${sa.project_id}/releases/cloud.firestore`;
  const releaseUrl = `${RULES_API}/${releaseName}`;
  const release = await jsonRequest<FirestoreRelease>(
    releaseUrl,
    { headers: headers.auth },
    'snapshot Firestore release',
  );
  const ruleset = await jsonRequest<FirestoreRuleset>(
    `${RULES_API}/${release.rulesetName}`,
    { headers: headers.auth },
    'snapshot Firestore ruleset',
  );
  return { release, ruleset, releaseName, releaseUrl };
}

export async function activateFirestoreRules(
  sa: ServiceAccount,
  headers: AccessHeaders,
  snapshot: Awaited<ReturnType<typeof snapshotFirestoreRules>>,
  files: FirestoreRulesFile[],
): Promise<string> {
  const created = await jsonRequest<{ name: string }>(
    `${RULES_API}/projects/${sa.project_id}/rulesets`,
    {
      method: 'POST',
      headers: headers.json,
      body: JSON.stringify({ source: { files } }),
    },
    'create Firestore probe ruleset',
  );
  await jsonRequest<FirestoreRelease>(
    snapshot.releaseUrl,
    {
      method: 'PATCH',
      headers: headers.json,
      body: JSON.stringify({
        release: { name: snapshot.releaseName, rulesetName: created.name },
      }),
    },
    'activate Firestore probe ruleset',
  );
  return created.name;
}

export async function restoreFirestoreRules(
  headers: AccessHeaders,
  snapshot: Awaited<ReturnType<typeof snapshotFirestoreRules>>,
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await jsonRequest<FirestoreRelease>(
        snapshot.releaseUrl,
        {
          method: 'PATCH',
          headers: headers.json,
          body: JSON.stringify({
            release: {
              name: snapshot.releaseName,
              rulesetName: snapshot.release.rulesetName,
            },
          }),
        },
        'restore original Firestore release',
      );
      const restored = await jsonRequest<FirestoreRelease>(
        snapshot.releaseUrl,
        { headers: headers.auth },
        'verify original Firestore release',
      );
      if (restored.rulesetName === snapshot.release.rulesetName) return;
      lastError = new Error(`restored release points to ${restored.rulesetName}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('Firestore rules restoration failed after bounded retries', {
    cause: lastError,
  });
}
