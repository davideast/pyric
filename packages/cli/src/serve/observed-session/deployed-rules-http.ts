/**
 * Strict read-only GET HTTP transport for deployed Security Rules inspection.
 *
 * Security invariants:
 * - Allowlisted HTTPS Firebase API origins only:
 *   - `https://firebaserules.googleapis.com/v1/projects/...`
 *   - `https://<instance>.firebaseio.com/.settings/rules.json`
 *   - `https://<instance>.<region>.firebasedatabase.app/.settings/rules.json`
 * - Hardcoded `method: 'GET'` and `redirect: 'manual'`: never writes, deploys,
 *   or follows cross-origin redirects that could leak the bearer header.
 * - Bearer token travels only in `Authorization: Bearer <token>`, never in URLs,
 *   query parameters, logs, or error messages.
 * - Bounded response body size (`MAX_DEPLOYED_RULES_RESPONSE_BYTES`).
 */

export const FIREBASE_RULES_API_ORIGIN = 'https://firebaserules.googleapis.com';
export const MAX_DEPLOYED_RULES_RESPONSE_BYTES = 2 * 1024 * 1024;

const DEFAULT_RULES_HTTP_TIMEOUT_MS = 10_000;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const FIRESTORE_DATABASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const STORAGE_BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const RULESET_NAME_PATTERN = /^projects\/([A-Za-z0-9][A-Za-z0-9-]{0,127})\/rulesets\/([A-Za-z0-9_-]{1,256})$/;
const RTDB_INSTANCE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RTDB_FIREBASEIO_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.firebaseio\.com$/;
const RTDB_REGIONAL_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.firebasedatabase\.app$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export type DeployedRulesFetchErrorCode =
  | 'invalid-target'
  | 'invalid-host'
  | 'unauthenticated'
  | 'token-expired'
  | 'permission-denied'
  | 'not-found'
  | 'redirect-blocked'
  | 'response-too-large'
  | 'http-error'
  | 'network-error'
  | 'parse-error';

export interface DeployedRulesFetchError {
  readonly code: DeployedRulesFetchErrorCode;
  readonly status?: number;
  readonly message: string;
}

export type DeployedRulesHttpResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: DeployedRulesFetchError };

export interface ReadOnlyRulesGetInput {
  readonly url: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export function validateProjectId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!PROJECT_ID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function validateFirestoreDatabaseId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '(default)') {
    return trimmed;
  }
  if (!FIRESTORE_DATABASE_ID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function validateStorageBucketId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.includes('..') || !STORAGE_BUCKET_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function validateRulesetResourceName(raw: string, expectedProjectId?: string): string | null {
  const trimmed = raw.trim();
  const match = RULESET_NAME_PATTERN.exec(trimmed);
  if (match === null) {
    return null;
  }
  if (expectedProjectId !== undefined && match[1] !== expectedProjectId) {
    return null;
  }
  return trimmed;
}

function isAllowedRtdbHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (RTDB_FIREBASEIO_HOST_PATTERN.test(lower)) {
    return true;
  }
  return RTDB_REGIONAL_HOST_PATTERN.test(lower);
}

/**
 * Resolves a Realtime Database instance name or HTTPS URL into an allowlisted
 * `/.settings/rules.json` GET URL, or `null` when the host is outside the
 * Firebase RTDB allowlist.
 */
export function resolveAllowedRtdbRulesUrl(databaseUrlOrInstance: string): string | null {
  const trimmed = databaseUrlOrInstance.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (RTDB_INSTANCE_NAME_PATTERN.test(lower)) {
    return `https://${lower}.firebaseio.com/.settings/rules.json`;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.port !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  if (!isAllowedRtdbHostname(parsed.hostname)) return null;
  const pathIsRootOrRules =
    parsed.pathname === '' || parsed.pathname === '/' || parsed.pathname === '/.settings/rules.json';
  if (!pathIsRootOrRules) return null;
  return `https://${parsed.hostname.toLowerCase()}/.settings/rules.json`;
}

function hasPathTraversalSegment(pathname: string): boolean {
  const segments = pathname.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') return true;
    try {
      const decoded = decodeURIComponent(segment);
      if (decoded === '..' || decoded === '.' || decoded.includes('/') || decoded.includes('\\')) {
        return true;
      }
    } catch (error: unknown) {
      if (error instanceof URIError) return true;
      throw error;
    }
  }
  return false;
}

/**
 * Defense-in-depth URL check verified immediately before any network GET.
 * Permits only HTTPS `firebaserules.googleapis.com/v1/projects/...` and
 * allowlisted RTDB `/.settings/rules.json` URLs with no userinfo, port,
 * query string, fragment, or traversal segments.
 */
export function isAllowedDeployedRulesUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.port !== '') return false;
  if (parsed.search !== '' || parsed.hash !== '') return false;
  if (hasPathTraversalSegment(parsed.pathname)) return false;

  const host = parsed.hostname.toLowerCase();
  if (host === 'firebaserules.googleapis.com') {
    return parsed.pathname.startsWith('/v1/projects/');
  }
  if (isAllowedRtdbHostname(host)) {
    return parsed.pathname === '/.settings/rules.json';
  }
  return false;
}

function isRedirectStatus(response: Response): boolean {
  if (response.type === 'opaqueredirect') return true;
  return response.status >= 300 && response.status < 400;
}

/** Best-effort cancellation of an unconsumed HTTP response body stream. */
export async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch (cancelError: unknown) {
    if (cancelError instanceof Error) {
      return;
    }
    throw cancelError;
  }
}

/** Reads a UTF-8 response body up to `maxBytes`, aborting stream reads past the cap. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly tooLarge: boolean }> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await cancelResponseBody(response);
      return { ok: false, tooLarge: true };
    }
  }

  if (response.body === null) {
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        return { ok: false, tooLarge: true };
      }
      return { ok: true, text };
    } catch (error: unknown) {
      void error;
      return { ok: false, tooLarge: false };
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch (cancelError: unknown) {
          void cancelError;
        }
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch (error: unknown) {
    void error;
    return { ok: false, tooLarge: false };
  }

  const merged = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  return { ok: true, text: merged.toString('utf8') };
}

/**
 * Executes a single read-only HTTPS GET against an allowlisted Firebase rules
 * endpoint using bearer authorization and `redirect: 'manual'`.
 */
export async function readOnlyRulesGet(input: ReadOnlyRulesGetInput): Promise<DeployedRulesHttpResult> {
  if (!isAllowedDeployedRulesUrl(input.url)) {
    return {
      ok: false,
      error: {
        code: 'invalid-host',
        message: 'Refused deployed rules request to a non-allowlisted URL.',
      },
    };
  }
  if (input.token.trim().length === 0 || CONTROL_CHARS.test(input.token)) {
    return {
      ok: false,
      error: {
        code: 'unauthenticated',
        message: 'Bearer token was missing or malformed.',
      },
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_RULES_HTTP_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? MAX_DEPLOYED_RULES_RESPONSE_BYTES;

  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${input.token.trim()}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    void error;
    return {
      ok: false,
      error: {
        code: 'network-error',
        message: 'Network error while reading deployed security rules.',
      },
    };
  }

  if (isRedirectStatus(response)) {
    await cancelResponseBody(response);
    return {
      ok: false,
      error: {
        code: 'redirect-blocked',
        status: response.status,
        message: `Blocked redirect (HTTP ${response.status}) while reading deployed security rules.`,
      },
    };
  }

  if (response.status === 401) {
    await cancelResponseBody(response);
    return {
      ok: false,
      error: {
        code: 'unauthenticated',
        status: 401,
        message: 'Firebase rejected the developer CLI credentials (HTTP 401). Run `firebase login` or `gcloud auth application-default login`.',
      },
    };
  }

  if (response.status === 403) {
    await cancelResponseBody(response);
    return {
      ok: false,
      error: {
        code: 'permission-denied',
        status: 403,
        message: 'Your CLI login lacks permission to read deployed security rules on this project (HTTP 403).',
      },
    };
  }

  if (response.status === 404) {
    await cancelResponseBody(response);
    return {
      ok: false,
      error: {
        code: 'not-found',
        status: 404,
        message: 'No active deployed rules release was found for this target (HTTP 404).',
      },
    };
  }

  if (!response.ok) {
    await cancelResponseBody(response);
    return {
      ok: false,
      error: {
        code: 'http-error',
        status: response.status,
        message: `Reading deployed security rules failed with HTTP ${response.status}.`,
      },
    };
  }

  const body = await readBoundedResponseText(response, maxBytes);
  if (!body.ok) {
    if (body.tooLarge) {
      return {
        ok: false,
        error: {
          code: 'response-too-large',
          message: `Deployed security rules response exceeded the ${maxBytes}-byte safety limit.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'network-error',
        message: 'Failed to read deployed security rules response body.',
      },
    };
  }

  return { ok: true, text: body.text };
}
