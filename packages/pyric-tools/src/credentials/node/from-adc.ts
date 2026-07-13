/**
 * Application Default Credentials source — the gcloud / workload-identity path,
 * the modern keyless alternative to a long-lived token. Reads the well-known ADC
 * file (`gcloud auth application-default login`):
 *   - `authorized_user` -> refresh-token grant (the common dev case).
 *   - `service_account` -> delegate to `fromServiceAccount`.
 * The metadata-server path (GCE / Cloud Run) is a separate fallback, not yet
 * wired. Node-only (reads disk) -> lives in node/.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProjectScope } from '../core/types.js';
import { memoizeTtl } from '../core/memoize-ttl.js';
import { fromServiceAccount } from './from-service-account.js';

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** The well-known ADC file path (honours CLOUDSDK_CONFIG; %APPDATA% on Windows). */
export function adcWellKnownPath(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.CLOUDSDK_CONFIG ??
    (process.platform === 'win32' && env.APPDATA ? join(env.APPDATA, 'gcloud') : join(homedir(), '.config', 'gcloud'));
  return join(base, 'application_default_credentials.json');
}

/**
 * Build a `ProjectScope` from ADC, or `null` if no ADC file is present. The
 * project is supplied by the caller — an ADC user credential isn't bound to one
 * (`--project` / `.firebaserc`).
 */
export async function fromAdc(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
  path: string = adcWellKnownPath(env),
): Promise<ProjectScope | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return null; // no ADC file
  }
  let parsed: { type?: string; client_id?: string; client_secret?: string; refresh_token?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed.type === 'authorized_user' && parsed.client_id && parsed.client_secret && parsed.refresh_token) {
    const clientId = parsed.client_id;
    const clientSecret = parsed.client_secret;
    const refreshToken = parsed.refresh_token;
    const resolveToken = memoizeTtl(async () => {
      const { access_token, expires_in } = await exchangeAdcRefreshToken(
        clientId,
        clientSecret,
        refreshToken,
      );
      return { token: access_token, expiresIn: expires_in };
    });
    return Object.freeze({ projectId, resolveToken });
  }

  if (parsed.type === 'service_account') {
    const sa = await fromServiceAccount(raw); // fromServiceAccount accepts a raw JSON string
    return projectId && projectId !== sa.projectId
      ? Object.freeze({ projectId, resolveToken: sa.resolveToken })
      : sa;
  }

  return null; // unknown ADC type (e.g. external_account) — not supported here
}

async function exchangeAdcRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number }> {
  const response = await fetch(GOOGLE_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) {
    throw new Error(
      `pyric: Application Default Credentials token exchange failed (${response.status}): ${await response.text()}`,
    );
  }
  return (await response.json()) as { access_token: string; expires_in: number };
}
