import {
  RULES_API,
  jsonRequest,
  type AccessHeaders,
  type ServiceAccount,
} from './storage-stdlib-real-api.ts';
import { type RequestBudget } from './storage-stdlib-real-budget.ts';

export interface Release { name: string; rulesetName: string }
export interface RulesFile { name: string; content: string }
export interface Ruleset { name: string; source: { files: RulesFile[] } }

export const STORAGE_MATCH = /(match\s+\/b\/\{bucket\}\/o\s*\{)/;

export function rulesLiteral(value: string): string {
  return JSON.stringify(value);
}

export function injectIntoMatch(source: string, pattern: RegExp, expected: string, block: string): string {
  const found = pattern.exec(source);
  if (!found) throw new Error(`current rules lack canonical ${expected} block`);
  const insertAt = found.index + found[0].length;
  return `${source.slice(0, insertAt)}${block}${source.slice(insertAt)}`;
}

export function replaceRulesFile(ruleset: Ruleset, selected: RulesFile, content: string): RulesFile[] {
  return ruleset.source.files.map((file) => file === selected ? { ...file, content } : file);
}

export function selectRulesFile(ruleset: Ruleset): RulesFile {
  const selected = ruleset.source.files.find((file) => file.name.endsWith('.rules')) ?? ruleset.source.files[0];
  if (!selected) throw new Error('current ruleset has no source file');
  return selected;
}

export async function storageRulesSnapshot(
  sa: ServiceAccount,
  bucket: string,
  headers: AccessHeaders,
  budget: RequestBudget,
): Promise<{ release: Release; ruleset: Ruleset; releaseName: string; releaseUrl: string }> {
  const releaseName = `projects/${sa.project_id}/releases/firebase.storage/${bucket}`;
  const releaseUrl = `${RULES_API}/${releaseName}`;
  budget.take('rules', 2);
  const release = await jsonRequest<Release>(releaseUrl, { headers: headers.auth }, 'snapshot Storage release');
  const ruleset = await jsonRequest<Ruleset>(
    `${RULES_API}/${release.rulesetName}`,
    { headers: headers.auth },
    'snapshot Storage ruleset',
  );
  return { release, ruleset, releaseName, releaseUrl };
}

export async function preflightStorageSource(
  sa: ServiceAccount,
  bucket: string,
  headers: AccessHeaders,
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
      testSuite: { testCases: [{
        expectation: 'ALLOW',
        request: { method: 'create', path: `/b/${bucket}/o/${path}`, resource: { size: 5 } },
      }] },
    }),
  });
  const result = await response.json() as {
    issues?: unknown[];
    testResults?: Array<{ state?: string }>;
    error?: unknown;
  };
  if (!response.ok || result.issues?.length || result.error || result.testResults?.[0]?.state !== 'SUCCESS') {
    throw new Error(`Storage source preflight failed: ${response.status} ${JSON.stringify(result)}`);
  }
}

export async function activateStorageSource(
  sa: ServiceAccount,
  headers: AccessHeaders,
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
    {
      method: 'PATCH',
      headers: headers.json,
      body: JSON.stringify({ release: { name: snapshot.releaseName, rulesetName: created.name } }),
    },
    'activate probe Storage ruleset',
  );
}

export async function restoreStorageRelease(
  headers: AccessHeaders,
  budget: RequestBudget,
  snapshot: Awaited<ReturnType<typeof storageRulesSnapshot>>,
): Promise<boolean> {
  budget.take('rules', 2);
  await jsonRequest(
    snapshot.releaseUrl,
    {
      method: 'PATCH',
      headers: headers.json,
      body: JSON.stringify({ release: {
        name: snapshot.releaseName,
        rulesetName: snapshot.release.rulesetName,
      } }),
    },
    'restore original Storage release',
  );
  const restored = await jsonRequest<Release>(
    snapshot.releaseUrl,
    { headers: headers.auth },
    'verify original Storage release',
  );
  return restored.rulesetName === snapshot.release.rulesetName;
}
