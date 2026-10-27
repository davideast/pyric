/**
 * Redaction for App Check captures. An App Check token, a debug token, an API
 * key, and the app id are never written to an observation: a token is recorded
 * by its shape, and any secret substring inside an error message is replaced
 * with a named placeholder.
 */

export interface Secrets {
  appId: string;
  apiKey: string;
  projectNumber: string;
  /** Token-like values seen during the run (debug tokens, minted tokens). */
  values: string[];
}

export interface JwtShape {
  length: number;
  segmentCount: number;
  isJwt: boolean;
  headerKeySet?: string[];
  alg?: unknown;
  typ?: unknown;
  kidPresent?: boolean;
  claimNames?: string[];
  issShape?: string;
  audShape?: unknown;
  subEqualsAppId?: boolean;
  ttlSeconds?: number;
  hasJti?: boolean;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function redactText(text: string, secrets: Secrets): string {
  let out = text;
  for (const value of secrets.values) if (value) out = out.split(value).join('<token>');
  if (secrets.appId) out = out.split(secrets.appId).join('<appId>');
  if (secrets.apiKey) out = out.split(secrets.apiKey).join('<apiKey>');
  if (secrets.projectNumber) out = out.split(secrets.projectNumber).join('<projectNumber>');
  return out;
}

/** Recursively redacts every string inside a JSON value. */
export function redactJson(value: unknown, secrets: Secrets): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactJson(v, secrets)]));
  }
  return value;
}

export function jwtShape(token: string, secrets: Secrets): JwtShape {
  const segments = token.split('.');
  const header = segments.length === 3 ? decodeSegment(segments[0]!) : null;
  const payload = segments.length === 3 ? decodeSegment(segments[1]!) : null;
  if (!header || !payload) return { length: token.length, segmentCount: segments.length, isJwt: false };
  const iat = typeof payload.iat === 'number' ? payload.iat : undefined;
  const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
  return {
    length: token.length,
    segmentCount: segments.length,
    isJwt: true,
    headerKeySet: Object.keys(header).sort(),
    alg: header.alg,
    typ: header.typ,
    kidPresent: typeof header.kid === 'string' && header.kid.length > 0,
    claimNames: Object.keys(payload).sort(),
    issShape: typeof payload.iss === 'string' ? redactText(payload.iss, secrets) : undefined,
    audShape: redactJson(payload.aud, secrets),
    subEqualsAppId: payload.sub === secrets.appId,
    ttlSeconds: iat !== undefined && exp !== undefined ? exp - iat : undefined,
    hasJti: 'jti' in payload,
  };
}

/** A token with its signature altered by one character, still three segments. */
export function tamperSignature(token: string): string {
  const [header, payload, signature] = token.split('.');
  const last = signature!.slice(-2, -1);
  const swapped = last === 'A' ? 'B' : 'A';
  return `${header}.${payload}.${signature!.slice(0, -2)}${swapped}${signature!.slice(-1)}`;
}
