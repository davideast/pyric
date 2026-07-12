import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ProjectAccess } from './project-access.js';

const FIREBASE_CLI_CLIENT_ID =
  '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLI_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';
const FIREBASE_CLI_TOKEN_URL = 'https://www.googleapis.com/oauth2/v3/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const EXPIRY_LEEWAY_MS = 5 * 60_000;

interface FirebaseCliTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

interface FirebaseCliConfig {
  tokens?: FirebaseCliTokens;
}

export interface FirebaseCliDeps {
  fetch?: typeof fetch;
  now?: () => number;
  readConfig?: () => Promise<FirebaseCliConfig | null>;
}

/**
 * Read an existing `firebase login` credential and adapt it for hosted
 * verification. This never starts an auth flow and never writes Firebase CLI
 * state; Firebase CLI remains the owner of the credential.
 */
export async function fromFirebaseCli(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: FirebaseCliDeps = {},
): Promise<ProjectAccess | null> {
  const config = await (deps.readConfig ?? (() => readFirebaseCliConfig(env)))();
  const stored = config?.tokens;
  if (!stored) return null;

  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let token = stored.access_token;
  let expiresAt = stored.expires_at ?? 0;
  const refreshToken = stored.refresh_token;

  const resolveToken = async (): Promise<string> => {
    if (token && expiresAt > now() + EXPIRY_LEEWAY_MS) return token;
    if (!refreshToken) {
      throw new Error('Firebase CLI login has no refresh token; run `firebase login --reauth`.');
    }

    const response = await fetchFn(env.FIREBASE_TOKEN_URL ?? FIREBASE_CLI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: env.FIREBASE_CLIENT_ID ?? FIREBASE_CLI_CLIENT_ID,
        client_secret: env.FIREBASE_CLIENT_SECRET ?? FIREBASE_CLI_CLIENT_SECRET,
        grant_type: 'refresh_token',
        scope: CLOUD_PLATFORM_SCOPE,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(
        `Firebase CLI credentials could not be refreshed (${response.status}); run \`firebase login --reauth\`.`,
      );
    }
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) {
      throw new Error('Firebase CLI token refresh returned no access token.');
    }
    token = body.access_token;
    expiresAt = now() + (body.expires_in ?? 3600) * 1000;
    return token;
  };

  try {
    await resolveToken();
  } catch {
    return null;
  }
  return Object.freeze({ projectId, resolveToken });
}

async function readFirebaseCliConfig(
  env: NodeJS.ProcessEnv,
): Promise<FirebaseCliConfig | null> {
  for (const path of firebaseCliConfigCandidates(env)) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as FirebaseCliConfig;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Missing and malformed candidates are equivalent to no CLI login.
    }
  }
  return null;
}

function firebaseCliConfigCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? homedir();
  const roots = [
    env.XDG_CONFIG_HOME,
    env.APPDATA,
    join(home, '.config'),
    join(home, 'Library', 'Preferences'),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(roots.map((root) => join(root, 'configstore', 'firebase-tools.json')))];
}
