/**
 * Whether a request's client runs on this machine, plus IPv4/IPv6 CIDR matching.
 *
 * The socket peer decides, because a client cannot choose it. A dev server or
 * proxy in front of the host connects from loopback whoever its client is, so a
 * Node server started under `pyric sandbox` carries the answer forward: it marks
 * a request from a non-loopback peer with `REMOTE_PEER_HEADER`
 * (`../register/remote-peer-mark.ts`).
 *
 * The header can only take access away. Its presence means remote whatever its
 * value, and there is no value that means local, so a client gains nothing by
 * sending it. A client of a marking server cannot remove it either: the server
 * sets it from the real socket before any handler reads the request.
 */
import { isIP } from 'node:net';

export const REMOTE_PEER_HEADER = 'x-pyric-remote-peer';

const ALL_32_BITS = 0xffff_ffffn;
const ALL_128_BITS = (1n << 128n) - 1n;
const IPV4_MAPPED_UPPER = 0xffffn;
const IPV4_DECIMAL_OCTET_RE = /^(?:0|[1-9]\d{0,2})$/;
const IPV6_HEX_GROUP_RE = /^[0-9a-f]{1,4}$/;
const CIDR_PREFIX_RE = /^(?:0|[1-9]\d{0,2})$/;
const ZONE_ID_RE = /^[a-z0-9._-]+$/i;

/** A normalized IPv4 or IPv6 IP/CIDR entry. IPv4-mapped IPv6 normalizes to family 4. */
export interface ParsedCidr {
  readonly family: 4 | 6;
  readonly network: bigint;
  readonly prefixLength: number;
  readonly raw: string;
}

interface NormalizedIp {
  readonly family: 4 | 6;
  readonly value: bigint;
  readonly wasMappedIpv4: boolean;
}

function ipv4Mask(prefixLength: number): bigint {
  const shift = BigInt(32 - prefixLength);
  return (ALL_32_BITS << shift) & ALL_32_BITS;
}

function ipv6Mask(prefixLength: number): bigint {
  const shift = BigInt(128 - prefixLength);
  return (ALL_128_BITS << shift) & ALL_128_BITS;
}

function parseIpv4ToBigInt(address: string): bigint | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!IPV4_DECIMAL_OCTET_RE.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6SegmentList(segment: string): number[] | null {
  if (segment === '') return [];
  const tokens = segment.split(':');
  const groups: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === '') return null;
    if (token.includes('.')) {
      if (index !== tokens.length - 1) return null;
      const ipv4 = parseIpv4ToBigInt(token);
      if (ipv4 === null) return null;
      groups.push(Number((ipv4 >> 16n) & 0xffffn));
      groups.push(Number(ipv4 & 0xffffn));
      continue;
    }
    if (!IPV6_HEX_GROUP_RE.test(token)) return null;
    groups.push(Number.parseInt(token, 16));
  }
  return groups;
}

function parseIpv6ToBigInt(address: string): bigint | null {
  if (isIP(address) !== 6) return null;
  const doubleColonIndex = address.indexOf('::');
  let groups: number[];
  if (doubleColonIndex !== -1) {
    if (address.indexOf('::', doubleColonIndex + 2) !== -1) return null;
    const leftRaw = address.slice(0, doubleColonIndex);
    const rightRaw = address.slice(doubleColonIndex + 2);
    const left = parseIpv6SegmentList(leftRaw);
    const right = parseIpv6SegmentList(rightRaw);
    if (left === null || right === null) return null;
    const missing = 8 - (left.length + right.length);
    if (missing <= 0) return null;
    groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  } else {
    const parsed = parseIpv6SegmentList(address);
    if (parsed === null || parsed.length !== 8) return null;
    groups = parsed;
  }
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(group);
  }
  return value;
}

function stripZoneId(address: string, allowZoneId: boolean): string | null {
  const pctIndex = address.indexOf('%');
  if (pctIndex === -1) return address;
  if (!allowZoneId) return null;
  const zone = address.slice(pctIndex + 1);
  if (!ZONE_ID_RE.test(zone)) return null;
  return address.slice(0, pctIndex);
}

function unwrapIpv6Brackets(raw: string): string | null {
  if (raw.startsWith('[') || raw.endsWith(']')) {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return null;
    return raw.slice(1, -1);
  }
  return raw;
}

function parseNormalizedIp(raw: string, allowZoneId: boolean): NormalizedIp | null {
  const lower = raw.trim().toLowerCase();
  if (lower === '') return null;
  const unwrapped = unwrapIpv6Brackets(lower);
  if (unwrapped === null || unwrapped === '') return null;
  const ipv4 = parseIpv4ToBigInt(unwrapped);
  if (ipv4 !== null) {
    if (lower.startsWith('[')) return null;
    return { family: 4, value: ipv4, wasMappedIpv4: false };
  }
  const withoutZone = stripZoneId(unwrapped, allowZoneId);
  if (withoutZone === null) return null;
  const ipv6 = parseIpv6ToBigInt(withoutZone);
  if (ipv6 === null) return null;
  if ((ipv6 >> 32n) === IPV4_MAPPED_UPPER) {
    return { family: 4, value: ipv6 & ALL_32_BITS, wasMappedIpv4: true };
  }
  return { family: 6, value: ipv6, wasMappedIpv4: false };
}

/**
 * True when an address represents an IP wildcard (`0.0.0.0`, `::`, `::ffff:0:0`).
 */
export function isWildcardIpAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const parsed = parseNormalizedIp(address, false);
  if (parsed === null) return false;
  return parsed.value === 0n;
}

/**
 * Parse a strict IP literal or CIDR range (IPv4, IPv6, or IPv4-mapped IPv6).
 *
 * Rejects malformed addresses, zone IDs, wildcard addresses (`0.0.0.0`, `::`,
 * `::ffff:0:0`), and zero-width masks (`0.0.0.0/0`, `::/0`, `::ffff:0:0/96`).
 */
export function parseCidr(entry: string): ParsedCidr | null {
  const trimmed = entry.trim().toLowerCase();
  if (trimmed === '' || /[\s*]/.test(trimmed)) return null;
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex === -1) {
    const parsed = parseNormalizedIp(trimmed, false);
    if (parsed === null || parsed.value === 0n) return null;
    const prefixLength = parsed.family === 4 ? 32 : 128;
    return { family: parsed.family, network: parsed.value, prefixLength, raw: entry.trim() };
  }
  if (trimmed.indexOf('/', slashIndex + 1) !== -1) return null;
  const ipPart = trimmed.slice(0, slashIndex);
  const prefixPart = trimmed.slice(slashIndex + 1);
  if (!CIDR_PREFIX_RE.test(prefixPart)) return null;
  const prefixLength = Number(prefixPart);
  if (prefixLength <= 0) return null;

  const parsed = parseNormalizedIp(ipPart, false);
  if (parsed === null) return null;

  if (parsed.wasMappedIpv4) {
    if (prefixLength <= 96 || prefixLength > 128) return null;
    const mappedPrefix = prefixLength - 96;
    return {
      family: 4,
      network: parsed.value & ipv4Mask(mappedPrefix),
      prefixLength: mappedPrefix,
      raw: entry.trim(),
    };
  }
  if (parsed.family === 4) {
    if (prefixLength > 32) return null;
    return {
      family: 4,
      network: parsed.value & ipv4Mask(prefixLength),
      prefixLength,
      raw: entry.trim(),
    };
  }
  if (prefixLength > 128) return null;
  return {
    family: 6,
    network: parsed.value & ipv6Mask(prefixLength),
    prefixLength,
    raw: entry.trim(),
  };
}

/** True when `address` falls inside `cidr` (normalizing dual-stack `::ffff:` peers). */
export function matchesCidr(address: string | undefined, cidr: ParsedCidr): boolean {
  if (address === undefined) return false;
  const parsed = parseNormalizedIp(address, true);
  if (parsed === null || parsed.family !== cidr.family) return false;
  if (cidr.family === 4) {
    return (parsed.value & ipv4Mask(cidr.prefixLength)) === cidr.network;
  }
  return (parsed.value & ipv6Mask(cidr.prefixLength)) === cidr.network;
}

/** True when `address` falls inside any entry in `entries`. */
export function matchesAnyCidr(address: string | undefined, entries: readonly ParsedCidr[]): boolean {
  for (const entry of entries) {
    if (matchesCidr(address, entry)) return true;
  }
  return false;
}

/**
 * True when a socket's peer address is loopback, so the client runs on this
 * machine. Unlike the Host header, the client cannot choose it. An unknown
 * address (a destroyed socket, a request with no socket) is not loopback.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const lower = address.trim().toLowerCase();
  if (lower.startsWith('[') || lower.endsWith(']')) return false;
  const parsed = parseNormalizedIp(lower, false);
  if (parsed === null) return false;
  if (parsed.family === 4) {
    return (parsed.value >> 24n) === 127n;
  }
  return parsed.value === 1n;
}

/** The parts of a request that say where it came from. */
export interface PeerRequest {
  socket?: { remoteAddress?: string } | null;
  headers?: Record<string, string | string[] | undefined>;
  headersDistinct?: Record<string, string[] | undefined>;
  /** Alternating names and values as the client sent them, in the client's casing. */
  rawHeaders?: string[];
}

/** True when the socket peer is on this machine and no server in front of it marked the client as remote. */
export function isLocalPeer(req: PeerRequest): boolean {
  const markedRemote = req.headers?.[REMOTE_PEER_HEADER] !== undefined;
  return !markedRemote && isLoopbackAddress(req.socket?.remoteAddress);
}
