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
 * This module imports no Firebase or Google auth code at load time. The
 * capture runners call `hasParityCredential()` on their inert path, which must
 * stay light.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthClient } from 'google-auth-library';
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

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * The ADC file a scope mints from, read when it first mints. google-auth-library
 * looks for the gcloud file only under `~/.config/gcloud` and ignores
 * `CLOUDSDK_CONFIG`, so the file is named here: the one
 * `resolveParityCredential` found.
 */
function adcFile(origin: 'GOOGLE_APPLICATION_CREDENTIALS' | 'gcloud'): string {
  if (origin === 'gcloud') return gcloudAdcPath(process.env, homedir());
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!file) throw new Error('GOOGLE_APPLICATION_CREDENTIALS was unset after the parity credential resolved.');
  return file;
}

/**
 * Mints tokens from the Application Default Credentials this scope owns. The
 * credential is built on first use from the file the environment names at
 * that moment. firebase-admin's `applicationDefault()` keeps one credential
 * per process, so a scope built after `GOOGLE_APPLICATION_CREDENTIALS`
 * changes would mint from whatever file an earlier caller read.
 *
 * The project id is passed in so `GoogleAuth` does not look one up. Without
 * it, `getClient()` runs `gcloud config config-helper`, probes the GCE
 * metadata server, and calls Cloud Resource Manager before it returns.
 */
function applicationDefaultToken(
  credential: Extract<ParityCredential, { source: 'adc' }>,
): () => Promise<{ token: string; expiresInSeconds: number }> {
  let client: AuthClient | undefined;
  return async () => {
    if (!client) {
      const { GoogleAuth } = await import('google-auth-library');
      client = await new GoogleAuth({
        scopes: [CLOUD_PLATFORM_SCOPE],
        projectId: credential.projectId,
        keyFilename: adcFile(credential.origin),
      }).getClient();
    }
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Application Default Credentials returned no access token.');
    const expiry = client.credentials.expiry_date ?? Date.now() + 3600_000;
    return { token, expiresInSeconds: Math.floor((expiry - Date.now()) / 1000) };
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
    return { projectId: credential.projectId, resolveToken: cachedTokenSource(applicationDefaultToken(credential)) };
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
