/**
 * Pure leaf helpers for `connectDatabaseEmulator(db, host, port, options?)`
 * shared across the in-process sandbox and served worker client planes.
 */
import type { EmulatorMockTokenOptions } from './types.js';

export const DELETED_DATABASE_USE_EMULATOR_ERROR =
  'FIREBASE FATAL ERROR: Cannot call useEmulator on a deleted database. ';

const POST_START_CONNECT_EMULATOR_ERROR =
  'FIREBASE FATAL ERROR: connectDatabaseEmulator() cannot initialize or alter the emulator configuration after the database instance has started. ';

const EMPTY_MOCK_USER_TOKEN_ERROR =
  "mockUserToken must contain 'sub' or 'user_id' field!";

const LEGACY_UID_MOCK_USER_TOKEN_ERROR =
  'The "uid" field is no longer supported by mockUserToken. Please use "sub" instead for Firebase Auth User ID.';

interface ParsedMockUserAuth {
  readonly uid: string;
  readonly token: Record<string, unknown>;
}

export interface EmulatorConnectOptions {
  mockUserToken?: string | EmulatorMockTokenOptions;
}

export interface AppliedEmulatorConfig {
  readonly hostAndPort: string;
  readonly normalizedOriginUrl: string;
  readonly optionsJson: string;
  readonly mockUserAuth?: ParsedMockUserAuth;
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) {
        out[key] = canonicalizeValue(entry);
      }
    }
    return out;
  }
  return value;
}

function serializeEmulatorOptions(options: EmulatorConnectOptions | undefined): string {
  let target: unknown = {};
  if (options !== undefined) {
    target = options;
  }
  return JSON.stringify(canonicalizeValue(target));
}

function decodeBase64UrlUtf8(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = base64.length % 4;
  let padded = base64;
  if (remainder > 0) {
    padded = base64 + '='.repeat(4 - remainder);
  }
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function parseJwtMockUserToken(jwt: string): ParsedMockUserAuth {
  const parts = jwt.split('.');
  const payloadSegment = parts[1];
  if (parts.length >= 2 && typeof payloadSegment === 'string' && payloadSegment.length > 0) {
    try {
      const parsed: unknown = JSON.parse(decodeBase64UrlUtf8(payloadSegment));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const claims = parsed as Record<string, unknown>;
        let uid: string | undefined;
        if (typeof claims.user_id === 'string' && claims.user_id.length > 0) {
          uid = claims.user_id;
        } else if (typeof claims.sub === 'string' && claims.sub.length > 0) {
          uid = claims.sub;
        }
        if (uid !== undefined) {
          return { uid, token: { ...claims } };
        }
      }
    } catch {
      // Fall back to opaque token string when payload is not valid JSON.
    }
  }
  return { uid: jwt, token: { sub: jwt, user_id: jwt } };
}

function parseObjectMockUserToken(
  rawToken: EmulatorMockTokenOptions,
  projectId: string | undefined,
): ParsedMockUserAuth {
  const record = rawToken as Record<string, unknown>;
  if (Boolean(record.uid)) {
    throw new Error(LEGACY_UID_MOCK_USER_TOKEN_ERROR);
  }
  let sub: string | undefined;
  if (typeof record.sub === 'string' && record.sub.length > 0) {
    sub = record.sub;
  } else if (typeof record.user_id === 'string' && record.user_id.length > 0) {
    sub = record.user_id;
  }
  if (sub === undefined) {
    throw new Error(EMPTY_MOCK_USER_TOKEN_ERROR);
  }
  let project = 'demo-project';
  if (typeof projectId === 'string' && projectId.length > 0) {
    project = projectId;
  }
  let iat = 0;
  if (typeof record.iat === 'number') {
    iat = record.iat;
  }
  const claims: Record<string, unknown> = {
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    iat,
    exp: iat + 3600,
    auth_time: iat,
    sub,
    user_id: sub,
    firebase: {
      sign_in_provider: 'custom',
      identities: {},
    },
  };
  for (const [key, val] of Object.entries(record)) {
    if (val !== undefined) {
      claims[key] = val;
    }
  }
  return { uid: sub, token: claims };
}

function parseMockUserToken(
  rawToken: string | EmulatorMockTokenOptions,
  projectId: string | undefined,
): ParsedMockUserAuth {
  if (typeof rawToken === 'string') {
    return parseJwtMockUserToken(rawToken);
  }
  return parseObjectMockUserToken(rawToken, projectId);
}

export function evaluateEmulatorConnect(
  started: boolean,
  previous: AppliedEmulatorConfig | undefined,
  host: string,
  port: number,
  options: EmulatorConnectOptions | undefined,
  projectId?: string,
): AppliedEmulatorConfig {
  const hostAndPort = `${host}:${port}`;
  const optionsJson = serializeEmulatorOptions(options);
  if (started) {
    if (
      previous !== undefined &&
      previous.hostAndPort === hostAndPort &&
      previous.optionsJson === optionsJson
    ) {
      return previous;
    }
    throw new Error(POST_START_CONNECT_EMULATOR_ERROR);
  }
  let mockUserAuth: ParsedMockUserAuth | undefined;
  if (options !== undefined && Boolean(options.mockUserToken)) {
    mockUserAuth = parseMockUserToken(
      options.mockUserToken as string | EmulatorMockTokenOptions,
      projectId,
    );
  }
  let urlHost = host.toLowerCase();
  if (urlHost.includes(':') && !urlHost.startsWith('[')) {
    urlHost = `[${urlHost}]`;
  }
  const normalizedOriginUrl = `http://${urlHost}:${port}/`;
  if (mockUserAuth !== undefined) {
    return {
      hostAndPort,
      normalizedOriginUrl,
      optionsJson,
      mockUserAuth,
    };
  }
  return {
    hostAndPort,
    normalizedOriginUrl,
    optionsJson,
  };
}
