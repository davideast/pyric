import { resolve } from 'node:path';
import type { OracleServiceAccount } from './oracle-credential.ts';

/** The oracle credential: a key file, or Application Default Credentials. See oracle-credential.ts. */
export type ServiceAccount = OracleServiceAccount;

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

export async function accessHeaders(sa: ServiceAccount): Promise<{
  auth: Record<string, string>;
  json: Record<string, string>;
}> {
  const access = await sa.credential.getAccessToken();
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
  sa: Pick<ServiceAccount, 'project_id'>,
  headers: AccessHeaders,
): Promise<{ projectId: string; storageBucket: string }> {
  return jsonRequest(
    `${FIREBASE_API}/projects/${sa.project_id}/adminSdkConfig`,
    { headers: headers.auth },
    'read Admin SDK config',
  );
}
