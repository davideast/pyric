/**
 * Read-only developer CLI login discovery for opt-in deployed-rules reading
 * in Live mode (`#2363`).
 *
 * Security contract:
 * - Strictly lazy: constructing the provider reads zero files and makes zero
 *   network calls. Files are touched only when `resolveToken()` is invoked by
 *   an explicitly opted-in host.
 * - Zero disk persistence: tokens live in closure memory only for the lifetime
 *   of the process and are never written to `.pyric/`, temp files, or env vars.
 * - Zero secret leakage: error messages contain only structured status codes
 *   and fixed guidance, never tokens, refresh tokens, client secrets, or raw
 *   HTTP error bodies.
 * - Hardcoded OAuth token endpoint (`https://oauth2.googleapis.com/token`)
 *   with `redirect: 'manual'` so credentials can never be redirected to
 *   another host.
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { firebaseToolsConfigstorePath } from '../../cli/firebase-project.js';
import { cancelResponseBody, readBoundedResponseText } from './deployed-rules-http.js';

export type DeployedRulesAuthSource = 'firebase-cli' | 'adc';

export type DeployedRulesAuthErrorCode =
  | 'unauthenticated'
  | 'token-expired'
  | 'redirect-blocked'
  | 'token-exchange-failed';

export type DeployedRulesTokenResult =
  | {
      readonly ok: true;
      readonly source: DeployedRulesAuthSource;
      readonly token: string;
      readonly expiresAt: number;
    }
  | {
      readonly ok: false;
      readonly code: DeployedRulesAuthErrorCode;
      readonly message: string;
    };

export interface DeployedRulesTokenProviderOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly minTtlMs?: number;
}

export interface DeployedRulesTokenProvider {
  resolveToken(): Promise<DeployedRulesTokenResult>;
}

/** Minimum remaining lifetime for an access token before refreshing or reporting expiry. */
export const CLI_TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Hardcoded Google OAuth2 token endpoint for ADC authorized_user refresh exchange. */
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;
const MAX_TOKEN_EXCHANGE_EXPIRES_IN_SECONDS = 86_400;
const MAX_CREDENTIAL_FILE_BYTES = 256 * 1024;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

interface CachedToken {
  readonly source: DeployedRulesAuthSource;
  readonly token: string;
  readonly expiresAt: number;
}

interface ParsedAuthorizedUserAdc {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHeaderSafeToken(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return !CONTROL_CHARS.test(trimmed);
}

function isFilesystemReadError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'EISDIR' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ELOOP'
  );
}

function nonEmptyEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/**
 * Well-known gcloud ADC path honoring `CLOUDSDK_CONFIG`, Windows `APPDATA`,
 * and `env.HOME` (falling back to `os.homedir()` only when `env.HOME` is unset
 * so tests overriding `env` never touch the developer's home directory).
 */
export function developerAdcPath(env: NodeJS.ProcessEnv = process.env): string {
  const cloudSdkConfig = nonEmptyEnv(env, 'CLOUDSDK_CONFIG');
  if (cloudSdkConfig !== undefined) {
    return join(cloudSdkConfig, 'application_default_credentials.json');
  }
  if (process.platform === 'win32') {
    const appData = nonEmptyEnv(env, 'APPDATA');
    if (appData !== undefined) {
      return join(appData, 'gcloud', 'application_default_credentials.json');
    }
  }
  const home = nonEmptyEnv(env, 'HOME') ?? homedir();
  return join(home, '.config', 'gcloud', 'application_default_credentials.json');
}

async function readTextIfPresent(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_CREDENTIAL_FILE_BYTES) {
      return null;
    }
    return await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isFilesystemReadError(error)) {
      return null;
    }
    throw error;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed)) {
      return parsed;
    }
    return null;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

type FirebaseCliTokenRead =
  | { readonly status: 'valid'; readonly token: string; readonly expiresAt: number }
  | { readonly status: 'expired' }
  | { readonly status: 'absent' };

function inspectTokenEntry(
  tokens: unknown,
  nowMs: number,
  minTtlMs: number,
): FirebaseCliTokenRead {
  if (!isPlainObject(tokens)) {
    return { status: 'absent' };
  }
  const accessToken = tokens.access_token;
  if (!isHeaderSafeToken(accessToken)) {
    return { status: 'absent' };
  }
  const expiresAt = tokens.expires_at;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return { status: 'expired' };
  }
  if (expiresAt - nowMs < minTtlMs) {
    return { status: 'expired' };
  }
  return { status: 'valid', token: accessToken.trim(), expiresAt };
}

async function readFirebaseCliToken(
  env: NodeJS.ProcessEnv,
  nowMs: number,
  minTtlMs: number,
): Promise<FirebaseCliTokenRead> {
  const storePath = firebaseToolsConfigstorePath(env);
  const raw = await readTextIfPresent(storePath);
  if (raw === null) {
    return { status: 'absent' };
  }
  const store = parseJsonObject(raw);
  if (store === null) {
    return { status: 'absent' };
  }

  let sawExpired = false;
  const direct = inspectTokenEntry(store.tokens, nowMs, minTtlMs);
  if (direct.status === 'valid') {
    return direct;
  }
  if (direct.status === 'expired') {
    sawExpired = true;
  }

  if (isPlainObject(store.user) && isNonEmptyString(store.user.email) && isPlainObject(store.users)) {
    const email = store.user.email.trim();
    if (Object.prototype.hasOwnProperty.call(store.users, email)) {
      const userEntry = store.users[email];
      if (isPlainObject(userEntry)) {
        const fromUser = inspectTokenEntry(userEntry.tokens, nowMs, minTtlMs);
        if (fromUser.status === 'valid') {
          return fromUser;
        }
        if (fromUser.status === 'expired') {
          sawExpired = true;
        }
      }
    }
  }

  if (sawExpired) {
    return { status: 'expired' };
  }
  return { status: 'absent' };
}

function parseAuthorizedUserAdc(raw: string): ParsedAuthorizedUserAdc | null {
  const parsed = parseJsonObject(raw);
  if (parsed === null || parsed.type !== 'authorized_user') {
    return null;
  }
  const clientId = parsed.client_id;
  const clientSecret = parsed.client_secret;
  const refreshToken = parsed.refresh_token;
  if (!isNonEmptyString(clientId) || !isNonEmptyString(clientSecret) || !isNonEmptyString(refreshToken)) {
    return null;
  }
  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    refreshToken: refreshToken.trim(),
  };
}

async function readAuthorizedUserAdc(env: NodeJS.ProcessEnv): Promise<ParsedAuthorizedUserAdc | null> {
  const candidates: string[] = [];
  const explicitPath = nonEmptyEnv(env, 'GOOGLE_APPLICATION_CREDENTIALS');
  if (explicitPath !== undefined) {
    candidates.push(explicitPath);
  }
  const wellKnown = developerAdcPath(env);
  if (!candidates.includes(wellKnown)) {
    candidates.push(wellKnown);
  }

  for (const candidate of candidates) {
    const raw = await readTextIfPresent(candidate);
    if (raw === null) continue;
    const adc = parseAuthorizedUserAdc(raw);
    if (adc !== null) {
      return adc;
    }
  }
  return null;
}

function isRedirectResponse(response: Response): boolean {
  if (response.type === 'opaqueredirect') return true;
  return response.status >= 300 && response.status < 400;
}

async function exchangeAdcRefreshToken(
  adc: ParsedAuthorizedUserAdc,
  fetchImpl: typeof fetch,
  nowMs: number,
  timeoutMs: number,
): Promise<DeployedRulesTokenResult> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: adc.clientId,
        client_secret: adc.clientSecret,
        refresh_token: adc.refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    void error;
    return {
      ok: false,
      code: 'token-exchange-failed',
      message: 'Could not reach the Google OAuth token endpoint to refresh Application Default Credentials.',
    };
  }

  if (isRedirectResponse(response)) {
    await cancelResponseBody(response);
    return {
      ok: false,
      code: 'redirect-blocked',
      message: `Blocked redirect (HTTP ${response.status}) from the Google OAuth token endpoint.`,
    };
  }

  if (!response.ok) {
    await cancelResponseBody(response);
    return {
      ok: false,
      code: 'token-exchange-failed',
      message: `Application Default Credentials token exchange failed (HTTP ${response.status}).`,
    };
  }

  const rawBody = await readBoundedResponseText(response, MAX_OAUTH_RESPONSE_BYTES);
  if (!rawBody.ok) {
    return {
      ok: false,
      code: 'token-exchange-failed',
      message: 'Application Default Credentials token response exceeded the safety limit or failed to read.',
    };
  }

  const body = parseJsonObject(rawBody.text);
  if (body === null) {
    return {
      ok: false,
      code: 'token-exchange-failed',
      message: 'Application Default Credentials token response was not valid JSON.',
    };
  }

  if (!isHeaderSafeToken(body.access_token)) {
    return {
      ok: false,
      code: 'token-exchange-failed',
      message: 'Application Default Credentials token response did not contain a valid access token.',
    };
  }

  let expiresInSeconds = 3600;
  if (typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0) {
    expiresInSeconds = Math.min(body.expires_in, MAX_TOKEN_EXCHANGE_EXPIRES_IN_SECONDS);
  }

  return {
    ok: true,
    source: 'adc',
    token: body.access_token.trim(),
    expiresAt: nowMs + Math.floor(expiresInSeconds * 1000),
  };
}

/**
 * Creates a lazy, read-only token provider that uses the developer's own CLI
 * login (`firebase login`, else `gcloud auth application-default login`).
 * Holds zero credentials on disk and never echoes credential material.
 */
export function createDeveloperCliTokenProvider(
  options: DeployedRulesTokenProviderOptions = {},
): DeployedRulesTokenProvider {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
  const minTtlMs = options.minTtlMs ?? CLI_TOKEN_REFRESH_MARGIN_MS;

  let cached: CachedToken | null = null;
  let inflight: Promise<DeployedRulesTokenResult> | null = null;

  async function resolveFresh(): Promise<DeployedRulesTokenResult> {
    const nowMs = now();
    if (cached !== null && cached.expiresAt - nowMs >= minTtlMs) {
      return {
        ok: true,
        source: cached.source,
        token: cached.token,
        expiresAt: cached.expiresAt,
      };
    }
    cached = null;

    const cliToken = await readFirebaseCliToken(env, nowMs, minTtlMs);
    if (cliToken.status === 'valid') {
      cached = { source: 'firebase-cli', token: cliToken.token, expiresAt: cliToken.expiresAt };
      return {
        ok: true,
        source: 'firebase-cli',
        token: cliToken.token,
        expiresAt: cliToken.expiresAt,
      };
    }

    const adc = await readAuthorizedUserAdc(env);
    if (adc !== null) {
      const exchanged = await exchangeAdcRefreshToken(adc, fetchImpl, nowMs, timeoutMs);
      if (exchanged.ok) {
        cached = {
          source: exchanged.source,
          token: exchanged.token,
          expiresAt: exchanged.expiresAt,
        };
      }
      return exchanged;
    }

    if (cliToken.status === 'expired') {
      return {
        ok: false,
        code: 'token-expired',
        message:
          'Your Firebase CLI access token has expired. Run `firebase login` or `gcloud auth application-default login` to refresh it.',
      };
    }

    return {
      ok: false,
      code: 'unauthenticated',
      message:
        'No developer CLI login found. Run `firebase login` or `gcloud auth application-default login` to read deployed rules.',
    };
  }

  return {
    async resolveToken(): Promise<DeployedRulesTokenResult> {
      const nowMs = now();
      if (cached !== null && cached.expiresAt - nowMs >= minTtlMs) {
        return {
          ok: true,
          source: cached.source,
          token: cached.token,
          expiresAt: cached.expiresAt,
        };
      }
      if (inflight === null) {
        inflight = resolveFresh().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  };
}
