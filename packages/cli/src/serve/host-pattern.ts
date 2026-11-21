/**
 * Strict parsing and matching for HTTP `Host` headers and `allowedHosts` entries.
 *
 * Supports exact hostnames (`devbox.example.com`, `devbox.example.com:5173`,
 * `[fd7a::1]:5173`) and Vite-aligned leading-dot subdomain suffixes
 * (`.tailnet.ts.net`, `.devbox.internal:8443`). Leading-dot patterns require at
 * least two DNS labels after the dot, and never match the bare suffix itself.
 */
import { isIP } from 'node:net';
import { isWildcardIpAddress } from './peer.js';

export interface ParsedHost {
  readonly hostname: string;
  readonly port: number | undefined;
}

export type AllowedHostPattern =
  | { readonly kind: 'exact'; readonly hostname: string; readonly port: number | undefined; readonly raw: string }
  | { readonly kind: 'suffix'; readonly suffix: string; readonly port: number | undefined; readonly raw: string };

const PORT_TOKEN_RE = /^[1-9]\d{0,4}$/;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INVALID_HOST_CHARS_RE = /[\s/\\?#@*]/;

function parsePortToken(token: string): number | null {
  if (!PORT_TOKEN_RE.test(token)) return null;
  const port = Number(token);
  if (port > 65535) return null;
  return port;
}

function stripSingleTrailingDot(hostname: string): string {
  if (hostname.endsWith('.')) return hostname.slice(0, -1);
  return hostname;
}

function canonicalIpv6(ipv6: string): string | null {
  try {
    const host = new URL(`http://[${ipv6}]`).hostname;
    if (host.startsWith('[') && host.endsWith(']')) {
      return host.slice(1, -1);
    }
    return host;
  } catch {
    return null;
  }
}

/** True when a hostname represents a wildcard bind address (`0`, `0.0.0.0`, `::`, `::ffff:0:0`). */
export function isWildcardHostname(hostname: string): boolean {
  const clean = hostname.replace(/\.+$/, '').toLowerCase();
  if (clean === '0' || clean === '0.0.0.0') return true;
  if (isWildcardIpAddress(clean)) return true;
  if (!clean.includes(':')) return false;
  try {
    const canonical = new URL(`http://[${clean}]`).hostname;
    return canonical === '[::]' || canonical === '[::ffff:0:0]';
  } catch {
    return /^[0:]+$/.test(clean);
  }
}

/** Parse a `Host` header value (`host` or `host:port`, including bracketed IPv6). */
export function parseHostHeader(raw: string): ParsedHost | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || INVALID_HOST_CHARS_RE.test(trimmed)) return null;

  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx <= 1) return null;
    const ipv6 = trimmed.slice(1, closeIdx);
    if (isIP(ipv6) !== 6) return null;
    const rest = trimmed.slice(closeIdx + 1);
    if (rest === '') return { hostname: ipv6, port: undefined };
    if (!rest.startsWith(':')) return null;
    const rawPort = rest.slice(1);
    if (rawPort.includes(':')) return null;
    const port = parsePortToken(rawPort);
    if (port === null) return null;
    return { hostname: ipv6, port };
  }

  if (trimmed.includes('[') || trimmed.includes(']')) return null;

  if (trimmed.indexOf(':') !== trimmed.lastIndexOf(':')) {
    if (isIP(trimmed) === 6) return { hostname: trimmed, port: undefined };
    return null;
  }

  const colon = trimmed.indexOf(':');
  let hostname = trimmed;
  let port: number | undefined;
  if (colon !== -1) {
    hostname = trimmed.slice(0, colon);
    const parsedPort = parsePortToken(trimmed.slice(colon + 1));
    if (parsedPort === null) return null;
    port = parsedPort;
  }
  if (hostname === '' || hostname.startsWith('.') || hostname.includes('..')) return null;
  const cleanHost = hostname.replace(/\.+$/, '');
  if (cleanHost === '') return null;
  if (/^\d+(?:\.\d+)+$/.test(cleanHost) && isIP(cleanHost) !== 4) {
    return null;
  }
  return { hostname, port };
}

function parseSuffixPattern(trimmed: string, raw: string): AllowedHostPattern | null {
  if (trimmed.includes('[') || trimmed.includes(']')) return null;
  if (trimmed.includes('..')) return null;
  const colon = trimmed.indexOf(':');
  let hostPart = trimmed;
  let port: number | undefined;
  if (colon !== -1) {
    if (trimmed.indexOf(':', colon + 1) !== -1) return null;
    hostPart = trimmed.slice(0, colon);
    const parsedPort = parsePortToken(trimmed.slice(colon + 1));
    if (parsedPort === null) return null;
    port = parsedPort;
  }
  const withoutLeadingDot = stripSingleTrailingDot(hostPart.slice(1));
  if (withoutLeadingDot === '' || withoutLeadingDot.length > 253) return null;
  const labels = withoutLeadingDot.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!DNS_LABEL_RE.test(label)) return null;
  }
  const tld = labels[labels.length - 1];
  if (tld === undefined || /^\d+$/.test(tld)) return null;
  return { kind: 'suffix', suffix: labels.join('.'), port, raw: raw.trim() };
}

/**
 * Parse a single `allowedHosts` entry into an exact host or leading-dot suffix rule.
 *
 * Rejects `*`, `true`, embedded wildcards (`*.example.com`), wildcard bind
 * addresses (`0`, `0.0.0.0`, `::`, `::ffff:0:0`), single-label leading-dot
 * suffixes (`.`, `.com`, `.dev`, `.local`), numeric-TLD suffixes, and invalid ports.
 */
export function parseAllowedHostEntry(raw: string): AllowedHostPattern | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'true' || INVALID_HOST_CHARS_RE.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith('.')) {
    return parseSuffixPattern(trimmed, raw);
  }
  const parsed = parseHostHeader(trimmed);
  if (parsed === null || isWildcardHostname(parsed.hostname)) return null;
  if (parsed.hostname.includes(':')) {
    const canonical = canonicalIpv6(parsed.hostname);
    if (canonical === null) return null;
    return { kind: 'exact', hostname: canonical, port: parsed.port, raw: raw.trim() };
  }
  const normalizedHost = stripSingleTrailingDot(parsed.hostname);
  if (normalizedHost === '') return null;
  return { kind: 'exact', hostname: normalizedHost, port: parsed.port, raw: raw.trim() };
}

/** Explain why a non-conforming `allowedHosts` entry was rejected. */
function describeInvalidAllowedHostEntry(raw: unknown): string {
  if (raw === true || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true')) {
    return "allowedHosts entry 'true' is not permitted; specify explicit hostnames or leading-dot subdomain patterns (for example '.tailnet.ts.net').";
  }
  if (typeof raw !== 'string') {
    return `allowedHosts entry must be a string (received ${typeof raw}).`;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return 'allowedHosts entry cannot be empty.';
  }
  if (trimmed.includes('*')) {
    return `allowedHosts entry '${trimmed}' cannot use '*' wildcards; use a leading-dot suffix with at least two DNS labels (for example '.example.com').`;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('.')) {
    return `allowedHosts leading-dot pattern '${trimmed}' must contain at least two valid DNS labels (for example '.tailnet.ts.net', never '.com' or '.dev').`;
  }
  const parsed = parseHostHeader(lower);
  if (parsed !== null && isWildcardHostname(parsed.hostname)) {
    return `allowedHosts entry '${trimmed}' cannot name a wildcard bind address.`;
  }
  return `allowedHosts entry '${trimmed}' is not a valid host or leading-dot subdomain pattern.`;
}

function canonicalHostForMatch(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (lower.includes(':')) {
    const canonical = canonicalIpv6(lower);
    if (canonical !== null) return canonical;
  }
  return stripSingleTrailingDot(lower);
}

/** True when a parsed hostname matches `pattern`'s hostname part (ignoring port). */
function hostnameMatchesAllowedPattern(hostname: string, pattern: AllowedHostPattern): boolean {
  const candidate = canonicalHostForMatch(hostname);
  if (pattern.kind === 'exact') {
    return candidate === pattern.hostname;
  }
  if (isIP(candidate) !== 0) return false;
  const suffixWithDot = `.${pattern.suffix}`;
  if (!candidate.endsWith(suffixWithDot)) return false;
  const prefixLength = candidate.length - suffixWithDot.length;
  if (prefixLength <= 0) return false;
  const prefix = candidate.slice(0, prefixLength);
  if (prefix.startsWith('.') || prefix.endsWith('.') || prefix.includes('..')) return false;
  for (const label of prefix.split('.')) {
    if (!DNS_LABEL_RE.test(label)) return false;
  }
  return true;
}

/** True when a parsed `Host` matches `pattern` (hostname/suffix and optional port). */
function matchesAllowedHostPattern(parsed: ParsedHost, pattern: AllowedHostPattern): boolean {
  if (!hostnameMatchesAllowedPattern(parsed.hostname, pattern)) return false;
  return pattern.port === undefined || pattern.port === parsed.port;
}

/** True when `parsed` matches any valid exact or leading-dot entry in `extra`. */
export function matchesAnyAllowedHost(parsed: ParsedHost, extra: readonly string[]): boolean {
  for (const rawEntry of extra) {
    const pattern = parseAllowedHostEntry(rawEntry);
    if (pattern === null) continue;
    if (matchesAllowedHostPattern(parsed, pattern)) return true;
  }
  return false;
}

/** True when `extra` contains a valid entry matching both `hostname` and an explicit `:port`. */
export function hasExplicitAllowedHostPort(
  hostname: string,
  port: number,
  extra: readonly string[],
): boolean {
  for (const rawEntry of extra) {
    const pattern = parseAllowedHostEntry(rawEntry);
    if (pattern === null || pattern.port === undefined) continue;
    if (pattern.port !== port) continue;
    if (hostnameMatchesAllowedPattern(hostname, pattern)) return true;
  }
  return false;
}

/** Normalize an array of candidate `allowedHosts` entries, throwing on any invalid entry. */
export function parseAllowedHostsStrict(entries: readonly unknown[]): AllowedHostPattern[] {
  const parsed: AllowedHostPattern[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw new Error(`pyric: ${describeInvalidAllowedHostEntry(entry)}`);
    }
    const pattern = parseAllowedHostEntry(entry);
    if (pattern === null) {
      throw new Error(`pyric: ${describeInvalidAllowedHostEntry(entry)}`);
    }
    parsed.push(pattern);
  }
  return parsed;
}
