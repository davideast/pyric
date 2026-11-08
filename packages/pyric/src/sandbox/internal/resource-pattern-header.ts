/**
 * Service header extraction and resourceId normalization for Firestore,
 * Realtime Database, and Cloud Storage resource patterns and concrete paths.
 */

export type AssuranceService = 'firestore' | 'rtdb' | 'storage';

export type HeaderKind = 'none' | 'concrete' | 'wildcard' | 'malformed';

export interface ExtractedServiceHeader {
  readonly headerKind: HeaderKind;
  readonly headerResourceId?: string;
  readonly bodyPath: string;
}

export const DEFAULT_RESOURCE_ID = '(default)';
export const REST_SEGMENT_RE = /^\{([^/{}=()$]+)=\*\*\}$/;
export const DOLLAR_VAR_RE = /^\$([^/{}=()$]+)$/;
export const DOLLAR_PAREN_VAR_RE = /^([^{}=$]*)\$\(([^/{}=()$]+)\)([^{}=$]*)$/;
export const BRACE_VAR_RE = /^([^{}=$]*)\{([^/{}=()$]+)\}([^{}=$]*)$/;

const RTDB_URL_SCHEME_RE = /^(?:https?|wss?):\/\//i;
const IPV4_HOST_RE = /^\d+(?:\.\d+){3}$/;
const RTDB_INSTANCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const FIRESTORE_HEADER_RE = /^(\/+)?databases(\/+)([^/]*)(\/+)documents(?=\/|$)(.*)$/;
const STORAGE_HEADER_RE = /^(\/+)?b(\/+)([^/]*)(\/+)o(?=\/|$)(.*)$/;

export function isWildcardToken(token: string): boolean {
  return (
    REST_SEGMENT_RE.test(token)
    || DOLLAR_VAR_RE.test(token)
    || DOLLAR_PAREN_VAR_RE.test(token)
    || BRACE_VAR_RE.test(token)
  );
}

function decodePercentComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function decodeRtdbUrlPath(rawPath: string): string {
  if (rawPath.length === 0) return '';
  return rawPath
    .split('/')
    .map((piece) => {
      if (piece.length === 0) return '';
      return decodePercentComponent(piece.replace(/\+/g, ' '));
    })
    .join('/');
}

function extractHostWithoutPort(authority: string): string | null {
  if (authority.length === 0) return null;
  if (authority.startsWith('[')) {
    const closeBracket = authority.indexOf(']');
    if (closeBracket < 0) return null;
    const remainder = authority.slice(closeBracket + 1);
    if (remainder.length > 0 && !/^:\d+$/.test(remainder)) return null;
    return authority.slice(0, closeBracket + 1);
  }
  const colonIndex = authority.indexOf(':');
  if (colonIndex === 0) return null;
  if (colonIndex > 0) {
    const portPart = authority.slice(colonIndex + 1);
    if (!/^\d+$/.test(portPart)) return null;
    return authority.slice(0, colonIndex);
  }
  return authority;
}

function findCaseSensitiveNsParam(queryString: string): string | undefined {
  let found: string | undefined;
  for (const segment of queryString.split('&')) {
    if (segment.length === 0) continue;
    const eqIndex = segment.indexOf('=');
    if (eqIndex < 0) continue;
    const key = decodePercentComponent(segment.slice(0, eqIndex));
    if (key === 'ns') {
      found = decodePercentComponent(segment.slice(eqIndex + 1));
    }
  }
  return found;
}

function isHostWithoutSubdomainNamespace(
  hostWithoutPort: string,
  hostLabels: readonly string[],
): boolean {
  if (hostWithoutPort.toLowerCase() === 'localhost') return true;
  if (hostWithoutPort.startsWith('[')) return true;
  if (IPV4_HOST_RE.test(hostWithoutPort)) return true;
  return hostLabels.length <= 2;
}

function parseRtdbUrlHeader(raw: string): ExtractedServiceHeader | undefined {
  const schemeMatch = RTDB_URL_SCHEME_RE.exec(raw);
  if (schemeMatch === null) return undefined;

  let clean = raw.slice(schemeMatch[0].length);
  const hashIndex = clean.indexOf('#');
  if (hashIndex >= 0) {
    clean = clean.slice(0, hashIndex);
  }

  let slashIndex = clean.indexOf('/');
  if (slashIndex === -1) slashIndex = clean.length;
  let questionIndex = clean.indexOf('?');
  if (questionIndex === -1) questionIndex = clean.length;

  const authority = clean.slice(0, Math.min(slashIndex, questionIndex));
  let rawPath = '';
  if (slashIndex < questionIndex) {
    rawPath = clean.slice(slashIndex, questionIndex);
  }
  let queryString = '';
  if (questionIndex < clean.length) {
    queryString = clean.slice(questionIndex + 1);
  }

  const bodyPath = decodeRtdbUrlPath(rawPath);
  const hostWithoutPort = extractHostWithoutPort(authority);
  if (hostWithoutPort === null || hostWithoutPort.length === 0) {
    return { headerKind: 'malformed', bodyPath };
  }

  const nsParam = findCaseSensitiveNsParam(queryString);
  if (nsParam !== undefined) {
    const trimmedNs = nsParam.trim();
    if (trimmedNs.length === 0) return { headerKind: 'malformed', bodyPath };
    if (isWildcardToken(trimmedNs)) return { headerKind: 'wildcard', bodyPath };
    return { headerKind: 'concrete', headerResourceId: trimmedNs, bodyPath };
  }

  const hostLabels = hostWithoutPort.split('.');
  if (hostLabels.some((label) => label.length === 0)) {
    return { headerKind: 'malformed', bodyPath };
  }
  if (isHostWithoutSubdomainNamespace(hostWithoutPort, hostLabels)) {
    return { headerKind: 'none', bodyPath };
  }

  const firstLabel = hostLabels[0]!;
  if (isWildcardToken(firstLabel)) {
    return { headerKind: 'wildcard', bodyPath };
  }
  return { headerKind: 'concrete', headerResourceId: firstLabel.toLowerCase(), bodyPath };
}

function extractBracketedHeader(
  trimmed: string,
  headerRe: RegExp,
): ExtractedServiceHeader | undefined {
  const match = headerRe.exec(trimmed);
  if (match === null) return undefined;

  const leading = match[1] ?? '';
  const sep1 = match[2]!;
  const idToken = match[3]!;
  const sep2 = match[4]!;
  const bodyPath = match[5] ?? '';

  if (leading.length > 1 || sep1.length > 1 || sep2.length > 1 || idToken.length === 0) {
    return { headerKind: 'malformed', bodyPath };
  }
  if (isWildcardToken(idToken)) {
    return { headerKind: 'wildcard', bodyPath };
  }
  return { headerKind: 'concrete', headerResourceId: idToken, bodyPath };
}

export function extractServiceHeader(
  service: AssuranceService,
  rawPath: string,
): ExtractedServiceHeader {
  const trimmed = rawPath.trim();

  if (service === 'storage' && trimmed.startsWith('gs://')) {
    const withoutScheme = trimmed.slice('gs://'.length);
    const firstSlash = withoutScheme.indexOf('/');
    let bucketToken = withoutScheme;
    let bodyPath = '';
    if (firstSlash >= 0) {
      bucketToken = withoutScheme.slice(0, firstSlash);
      bodyPath = withoutScheme.slice(firstSlash);
    }
    if (bucketToken.length === 0) {
      return { headerKind: 'malformed', bodyPath };
    }
    if (isWildcardToken(bucketToken)) {
      return { headerKind: 'wildcard', bodyPath };
    }
    return { headerKind: 'concrete', headerResourceId: bucketToken, bodyPath };
  }

  if (service === 'rtdb') {
    return parseRtdbUrlHeader(trimmed) ?? { headerKind: 'none', bodyPath: trimmed };
  }

  if (service === 'firestore') {
    return (
      extractBracketedHeader(trimmed, FIRESTORE_HEADER_RE)
      ?? { headerKind: 'none', bodyPath: trimmed }
    );
  }

  return (
    extractBracketedHeader(trimmed, STORAGE_HEADER_RE)
    ?? { headerKind: 'none', bodyPath: trimmed }
  );
}

type ExplicitResourceIdClassification =
  | { readonly kind: 'omitted' }
  | { readonly kind: 'concrete'; readonly id: string }
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'invalid' };

function classifyExplicitResourceId(
  service: AssuranceService,
  resourceId: string | undefined,
): ExplicitResourceIdClassification {
  if (resourceId === undefined) return { kind: 'omitted' };
  const trimmed = resourceId.trim();
  if (trimmed.length === 0) return { kind: 'invalid' };

  if (service === 'storage' && trimmed.startsWith('gs://')) {
    const stripped = trimmed.slice('gs://'.length).replace(/\/+$/, '');
    if (stripped.length === 0 || stripped.includes('/')) return { kind: 'invalid' };
    if (isWildcardToken(stripped)) return { kind: 'wildcard' };
    return { kind: 'concrete', id: stripped };
  }

  if (service === 'rtdb') {
    const parsedUrl = parseRtdbUrlHeader(trimmed);
    if (parsedUrl !== undefined) {
      if (parsedUrl.headerKind === 'malformed') return { kind: 'invalid' };
      if (parsedUrl.headerKind === 'wildcard') return { kind: 'wildcard' };
      if (parsedUrl.headerKind === 'concrete' && parsedUrl.headerResourceId !== undefined) {
        return { kind: 'concrete', id: parsedUrl.headerResourceId };
      }
      return { kind: 'concrete', id: DEFAULT_RESOURCE_ID };
    }

    const stripped = trimmed.replace(/^\/+|\/+$/g, '');
    if (stripped.length === 0 || stripped.includes('/')) return { kind: 'invalid' };
    if (isWildcardToken(stripped)) return { kind: 'wildcard' };
    if (stripped.toLowerCase() === 'default' || stripped === DEFAULT_RESOURCE_ID) {
      return { kind: 'concrete', id: DEFAULT_RESOURCE_ID };
    }
    if (/^[^./:?#]+$/.test(stripped)) {
      if (RTDB_INSTANCE_NAME_RE.test(stripped)) {
        return { kind: 'concrete', id: stripped.toLowerCase() };
      }
      return { kind: 'concrete', id: stripped };
    }
    const schemelessUrl = parseRtdbUrlHeader(`https://${stripped}`);
    if (schemelessUrl !== undefined) {
      if (schemelessUrl.headerKind === 'malformed') return { kind: 'invalid' };
      if (schemelessUrl.headerKind === 'wildcard') return { kind: 'wildcard' };
      if (schemelessUrl.headerKind === 'concrete' && schemelessUrl.headerResourceId !== undefined) {
        return { kind: 'concrete', id: schemelessUrl.headerResourceId };
      }
      return { kind: 'concrete', id: DEFAULT_RESOURCE_ID };
    }
    return { kind: 'invalid' };
  }

  const stripped = trimmed.replace(/^\/+|\/+$/g, '');
  if (stripped.length === 0 || stripped.includes('/')) return { kind: 'invalid' };
  if (isWildcardToken(stripped)) return { kind: 'wildcard' };
  return { kind: 'concrete', id: stripped };
}

export function normalizeExplicitResourceId(
  service: AssuranceService,
  resourceId: string | undefined,
): string | undefined {
  const classified = classifyExplicitResourceId(service, resourceId);
  if (classified.kind === 'concrete') return classified.id;
  return undefined;
}

export function resolvePatternResourceId(
  service: AssuranceService,
  explicitResourceId: string | undefined,
  extracted: ExtractedServiceHeader,
): string {
  if (extracted.headerKind === 'concrete' && extracted.headerResourceId !== undefined) {
    return extracted.headerResourceId;
  }
  return normalizeExplicitResourceId(service, explicitResourceId) ?? DEFAULT_RESOURCE_ID;
}

export function resolveConcreteResourceId(
  service: AssuranceService,
  explicitResourceId: string | undefined,
  extracted: ExtractedServiceHeader,
): string | null {
  if (extracted.headerKind === 'malformed' || extracted.headerKind === 'wildcard') {
    return null;
  }
  const classified = classifyExplicitResourceId(service, explicitResourceId);
  if (classified.kind === 'wildcard' || classified.kind === 'invalid') {
    return null;
  }
  if (extracted.headerKind === 'concrete') {
    const headerId = extracted.headerResourceId!;
    if (classified.kind === 'concrete' && classified.id !== headerId) {
      return null;
    }
    return headerId;
  }
  if (classified.kind === 'concrete') return classified.id;
  return DEFAULT_RESOURCE_ID;
}
