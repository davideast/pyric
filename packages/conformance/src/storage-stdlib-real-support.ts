import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cert } from 'firebase-admin/app';

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

export function resolveServiceAccount(path: string): ServiceAccount {
  const resolved = resolve('/home/david/repos/davideast/pyric', path);
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
