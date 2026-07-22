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

export const RULES_API = 'https://firebaserules.googleapis.com/v1';
export const FIREBASE_API = 'https://firebase.googleapis.com/v1beta1';
export type AccessHeaders = Awaited<ReturnType<typeof accessHeaders>>;

export function resolveCredentialPath(path: string, cwd = process.cwd()): string {
  return resolve(cwd, path);
}

export function resolveServiceAccount(path: string): ServiceAccount {
  return JSON.parse(readFileSync(resolveCredentialPath(path), 'utf8')) as ServiceAccount;
}

export async function accessHeaders(sa: ServiceAccount): Promise<{
  auth: Record<string, string>;
  json: Record<string, string>;
}> {
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

export async function storageConfig(
  sa: ServiceAccount,
  headers: AccessHeaders,
): Promise<{ projectId: string; storageBucket: string }> {
  return jsonRequest(
    `${FIREBASE_API}/projects/${sa.project_id}/adminSdkConfig`,
    { headers: headers.auth },
    'read Admin SDK config',
  );
}
