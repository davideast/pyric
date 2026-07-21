import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert } from 'firebase-admin/app';
import { readObservationLinkage } from './observation-linkage.ts';

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface WebConfig {
  apiKey: string;
  projectId: string;
  appId?: string;
  authDomain?: string;
}

export interface Release { name: string; rulesetName: string }
export interface RulesFile { name: string; content: string }
export interface Ruleset { name: string; source: { files: RulesFile[] } }
export interface IamBinding { role: string; members: string[]; condition?: unknown }
export interface IamPolicy { version?: number; etag?: string; bindings?: IamBinding[]; auditConfigs?: unknown[] }
export type AccessHeaders = Awaited<ReturnType<typeof accessHeaders>>;
export type StorageDecision = { allowed: boolean; code?: string; message?: string };
export interface GcsObject {
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
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_DIR = join(HERE, '..', 'observations', 'storage-rules');
const RULES_API = 'https://firebaserules.googleapis.com/v1';
const FIREBASE_API = 'https://firebase.googleapis.com/v1beta1';
export const STORAGE_MATCH = /(match\s+\/b\/\{bucket\}\/o\s*\{)/;
export const STORAGE_PROBE_LIMITS = { storage: 40, firestoreWrite: 25, rules: 20, iam: 12 } as const;

export type BudgetKind = 'storage' | 'firestoreWrite' | 'rules' | 'iam';

export class RequestBudget {
  readonly counts: Record<BudgetKind, number> = { storage: 0, firestoreWrite: 0, rules: 0, iam: 0 };

  constructor(readonly limits: Record<BudgetKind, number>) {}

  take(kind: BudgetKind, amount = 1): void {
    const next = this.counts[kind] + amount;
    if (next > this.limits[kind]) {
      throw new Error(`${kind} request budget exceeded: ${next} > ${this.limits[kind]}`);
    }
    this.counts[kind] = next;
  }

  snapshot(): { counts: Record<BudgetKind, number>; limits: Record<BudgetKind, number> } {
    return { counts: { ...this.counts }, limits: { ...this.limits } };
  }
}

export async function runCleanupSteps(steps: Array<{ label: string; run: () => Promise<void> }>): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push(new Error(`${step.label}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'real-resource cleanup failed');
}

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

export function canonicalPolicy(policy: IamPolicy): string {
  const bindings = (policy.bindings ?? []).map((binding) => ({
    ...binding,
    members: [...binding.members].sort(),
  })).sort((a, b) => `${a.role}:${JSON.stringify(a.condition)}`.localeCompare(`${b.role}:${JSON.stringify(b.condition)}`));
  return JSON.stringify({ version: policy.version ?? 0, bindings, auditConfigs: policy.auditConfigs ?? [] });
}

export function resolveCredentialPath(path: string, cwd = process.cwd()): string {
  return resolve(cwd, path);
}

export function resolveServiceAccount(path: string): ServiceAccount {
  const resolved = resolveCredentialPath(path);
  return JSON.parse(readFileSync(resolved, 'utf8')) as ServiceAccount;
}

export async function accessHeaders(sa: ServiceAccount): Promise<{ auth: Record<string, string>; json: Record<string, string> }> {
  const credential = cert(sa as Parameters<typeof cert>[0]);
  const access = await credential.getAccessToken();
  const auth = { Authorization: `Bearer ${access.access_token}` };
  return { auth, json: { ...auth, 'Content-Type': 'application/json' } };
}

export async function jsonRequest<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

export function firestoreDocumentName(projectId: string, database: string, runId: string, id: string): string {
  return `projects/${projectId}/databases/${database}/documents/__pyric_storage_stdlib/${runId}/docs/${id}`;
}

function resolvedFirebaseVersion(): string {
  return (JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('firebase/package.json')), 'utf8')) as { version: string }).version;
}

export function writeStorageObservations(values: Array<Record<string, unknown>>): void {
  mkdirSync(OBS_DIR, { recursive: true });
  for (const value of values) {
    const path = join(OBS_DIR, `${value.name as string}.json`);
    const linkage = readObservationLinkage(path);
    writeFileSync(path, `${JSON.stringify({ ...value, ...linkage }, null, 2)}\n`);
    console.log(`[storage-stdlib:remaining] wrote ${path}`);
  }
}

export function storageObservation(
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

export async function storageConfig(sa: ServiceAccount, headers: AccessHeaders): Promise<{ projectId: string; storageBucket: string }> {
  return jsonRequest(
    `${FIREBASE_API}/projects/${sa.project_id}/adminSdkConfig`,
    { headers: headers.auth },
    'read Admin SDK config',
  );
}

export async function storageRulesSnapshot(sa: ServiceAccount, bucket: string, headers: AccessHeaders, budget: RequestBudget): Promise<{
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
      testSuite: { testCases: [{ expectation: 'ALLOW', request: { method: 'create', path: `/b/${bucket}/o/${path}`, resource: { size: 5 } } }] },
    }),
  });
  const result = await response.json() as { issues?: unknown[]; testResults?: Array<{ state?: string }>; error?: unknown };
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
    { method: 'PATCH', headers: headers.json, body: JSON.stringify({ release: { name: snapshot.releaseName, rulesetName: created.name } }) },
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
    { method: 'PATCH', headers: headers.json, body: JSON.stringify({ release: { name: snapshot.releaseName, rulesetName: snapshot.release.rulesetName } }) },
    'restore original Storage release',
  );
  const restored = await jsonRequest<Release>(snapshot.releaseUrl, { headers: headers.auth }, 'verify original Storage release');
  return restored.rulesetName === snapshot.release.rulesetName;
}

export async function gcsUpload(
  bucket: string,
  path: string,
  payload: Uint8Array,
  headers: AccessHeaders,
  budget: RequestBudget,
): Promise<GcsObject> {
  budget.take('storage');
  return jsonRequest<GcsObject>(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(path)}`,
    { method: 'POST', headers: { ...headers.auth, 'Content-Type': 'application/octet-stream' }, body: payload.buffer as ArrayBuffer },
    `upload seed object ${path}`,
  );
}

export async function gcsMetadata(bucket: string, path: string, headers: AccessHeaders, budget: RequestBudget): Promise<GcsObject> {
  budget.take('storage');
  return jsonRequest<GcsObject>(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
    { headers: headers.auth },
    `read object metadata ${path}`,
  );
}

export async function deleteStorageObjects(
  bucket: string,
  prefix: string,
  objects: Set<string>,
  headers: AccessHeaders,
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

export function storageDecision(error?: unknown): StorageDecision {
  if (!error) return { allowed: true };
  return {
    allowed: false,
    code: (error as { code?: string }).code,
    message: error instanceof Error ? error.message : String(error),
  };
}
