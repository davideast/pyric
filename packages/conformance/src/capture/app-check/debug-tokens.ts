/**
 * Debug-token lifecycle for the App Check rig: register one run-scoped debug
 * token, delete it afterwards, and sweep tokens an interrupted run left behind.
 * The token value never leaves this process except to the App Check API and
 * the headless page that exchanges it.
 */
import { randomUUID } from 'node:crypto';

export const DEBUG_TOKEN_PREFIX = 'pyric-app-check-capture-';
const API = 'https://firebaseappcheck.googleapis.com/v1';

export interface RegisteredDebugToken {
  name: string;
  displayName: string;
  value: string;
}

interface DebugTokenResource {
  name: string;
  displayName?: string;
}

async function request(url: string, init: RequestInit, label: string): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
  return text ? JSON.parse(text) : {};
}

function appPath(projectId: string, appId: string): string {
  return `${API}/projects/${projectId}/apps/${appId}`;
}

export async function listRunTokens(headers: Record<string, string>, projectId: string, appId: string): Promise<DebugTokenResource[]> {
  const body = (await request(`${appPath(projectId, appId)}/debugTokens`, { headers }, 'list debug tokens')) as {
    debugTokens?: DebugTokenResource[];
  };
  return (body.debugTokens ?? []).filter((token) => token.displayName?.startsWith(DEBUG_TOKEN_PREFIX));
}

export async function deleteDebugToken(headers: Record<string, string>, name: string): Promise<void> {
  await request(`${API}/${name}`, { method: 'DELETE', headers }, 'delete debug token');
}

/** Deletes every debug token this rig registered in an earlier, interrupted run. */
export async function sweepRunTokens(headers: Record<string, string>, projectId: string, appId: string): Promise<number> {
  const stale = await listRunTokens(headers, projectId, appId);
  for (const token of stale) await deleteDebugToken(headers, token.name);
  return stale.length;
}

export async function registerDebugToken(
  headers: Record<string, string>,
  projectId: string,
  appId: string,
  runId: string,
): Promise<RegisteredDebugToken> {
  const displayName = `${DEBUG_TOKEN_PREFIX}${runId}`;
  const value = randomUUID();
  const created = (await request(
    `${appPath(projectId, appId)}/debugTokens`,
    { method: 'POST', headers, body: JSON.stringify({ displayName, token: value }) },
    'create debug token',
  )) as DebugTokenResource;
  return { name: created.name, displayName, value };
}
