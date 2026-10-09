/**
 * Credential selection for the live Rules Test API runs: the parity packs in
 * this directory and the conformance capture runners that import
 * `parityScope()`.
 *
 * Sources, in order:
 *   1. `GOOGLE_APPLICATION_CREDENTIALS`: an Application Default Credentials
 *      file. In CI this is the external-account file that Workload Identity
 *      Federation writes; locally it can name a service account key file.
 *   2. A firebase-tools login (`~/.config/configstore/firebase-tools.json`).
 *   3. The gcloud ADC file written by `gcloud auth application-default login`
 *      (`$CLOUDSDK_CONFIG/application_default_credentials.json`, default
 *      `~/.config/gcloud`).
 *
 * The project under test is `PARITY_PROJECT_ID`, then `GOOGLE_CLOUD_PROJECT`
 * or `GCLOUD_PROJECT` for an ADC source, then `digame-mas`.
 *
 * With no source, the live suites skip and the capture runners print their
 * inert plan. `PARITY_REQUIRE_CREDENTIAL=1` turns that skip into an error, so a
 * CI job that expects a credential cannot pass by skipping.
 *
 * This module imports no Firebase code at load time. The capture runners call
 * `hasParityCredential()` on their inert path, which must stay light.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectScope } from '../../../src/project-scope.js';

export const DEFAULT_PARITY_PROJECT_ID = 'digame-mas';

export type ParityCredential =
  | { source: 'adc'; projectId: string; origin: 'GOOGLE_APPLICATION_CREDENTIALS' | 'gcloud' }
  | { source: 'firebase-tools'; projectId: string; configPath: string }
  | { source: 'none' };

export interface CredentialEnvironment {
  env: Record<string, string | undefined>;
  home: string;
  exists: (path: string) => boolean;
}

function defaultEnvironment(): CredentialEnvironment {
  return { env: process.env, home: homedir(), exists: existsSync };
}

export function firebaseToolsConfigPath(home: string): string {
  return join(home, '.config', 'configstore', 'firebase-tools.json');
}

export function gcloudAdcPath(env: Record<string, string | undefined>, home: string): string {
  const configDir = env.CLOUDSDK_CONFIG || join(home, '.config', 'gcloud');
  return join(configDir, 'application_default_credentials.json');
}

export function resolveParityCredential(
  input: CredentialEnvironment = defaultEnvironment(),
): ParityCredential {
  const { env, home, exists } = input;
  const adcProject = env.PARITY_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || DEFAULT_PARITY_PROJECT_ID;
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    return { source: 'adc', projectId: adcProject, origin: 'GOOGLE_APPLICATION_CREDENTIALS' };
  }
  const configPath = firebaseToolsConfigPath(home);
  if (exists(configPath)) {
    return { source: 'firebase-tools', projectId: env.PARITY_PROJECT_ID || DEFAULT_PARITY_PROJECT_ID, configPath };
  }
  if (exists(gcloudAdcPath(env, home))) {
    return { source: 'adc', projectId: adcProject, origin: 'gcloud' };
  }
  return { source: 'none' };
}

export const NO_CREDENTIAL_MESSAGE =
  'No Rules Test API credential found. Set GOOGLE_APPLICATION_CREDENTIALS, run `firebase login`, ' +
  'or run `gcloud auth application-default login`.';

/**
 * True when a credential source resolves. False when none does, unless
 * `PARITY_REQUIRE_CREDENTIAL=1`, in which case the absence is an error.
 */
export function hasParityCredential(input: CredentialEnvironment = defaultEnvironment()): boolean {
  if (resolveParityCredential(input).source !== 'none') return true;
  if (input.env.PARITY_REQUIRE_CREDENTIAL === '1') {
    throw new Error(`PARITY_REQUIRE_CREDENTIAL=1 is set. ${NO_CREDENTIAL_MESSAGE}`);
  }
  return false;
}

type CachedToken = { token: string; expiresAt: number };

function cachedTokenSource(mint: () => Promise<{ token: string; expiresInSeconds: number }>): () => Promise<string> {
  let cached: CachedToken | undefined;
  return async () => {
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
    const { token, expiresInSeconds } = await mint();
    cached = { token, expiresAt: Date.now() + expiresInSeconds * 1000 };
    return token;
  };
}

/**
 * The `ProjectScope` for the resolved credential. Token minting is lazy: a
 * credential that cannot mint a token (a deleted key, a rejected federation
 * exchange, a missing file) rejects from `resolveToken()`, and every caller
 * surfaces that rejection as a failure.
 */
export function parityScope(credential: ParityCredential = resolveParityCredential()): ProjectScope {
  if (credential.source === 'adc') {
    let adc: { getAccessToken(): Promise<{ access_token: string; expires_in: number }> } | undefined;
    return {
      projectId: credential.projectId,
      resolveToken: cachedTokenSource(async () => {
        if (!adc) {
          const { applicationDefault } = await import('firebase-admin/app');
          adc = applicationDefault();
        }
        const t = await adc.getAccessToken();
        return { token: t.access_token, expiresInSeconds: t.expires_in };
      }),
    };
  }
  if (credential.source === 'firebase-tools') {
    const { configPath } = credential;
    return {
      projectId: credential.projectId,
      resolveToken: cachedTokenSource(async () => {
        const data = JSON.parse(readFileSync(configPath, 'utf8')) as {
          user?: { email: string };
          users?: Record<string, { tokens?: { refresh_token?: string } }>;
          tokens?: { refresh_token?: string };
        };
        const email = data.user?.email;
        const refreshToken = (email && data.users?.[email]?.tokens?.refresh_token) || data.tokens?.refresh_token;
        if (!refreshToken) throw new Error('No refresh token found in firebase-tools configuration.');
        const res = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
            client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          }),
        });
        if (!res.ok) throw new Error(`OAuth token refresh failed: HTTP ${res.status}`);
        const json = await res.json() as { access_token: string; expires_in?: number };
        return { token: json.access_token, expiresInSeconds: json.expires_in ?? 3600 };
      }),
    };
  }
  throw new Error(NO_CREDENTIAL_MESSAGE);
}
