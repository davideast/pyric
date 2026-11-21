/**
 * Strict CLI flag and environment variable parsers for remote access options
 * (`--allowed-host`, `--allow-remote-peers`, `--trust-proxy`).
 */
import { parseAllowedHostsStrict } from './host-pattern.js';
import { parseAllowPeersSetting, parseTrustProxySetting } from './guard-policy.js';

function splitCsvValues(raw: string | readonly string[]): string[] {
  const inputs = typeof raw === 'string' ? [raw] : raw;
  const out: string[] = [];
  for (const item of inputs) {
    for (const part of item.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

/**
 * Parse comma-separated or repeated host entries using the strict leading-dot
 * allowlist rules (`>= 2` DNS labels, no `*`, `true`, or wildcard IPs).
 */
export function parseAllowedHostsInput(raw: string | readonly string[]): string[] {
  const entries = splitCsvValues(raw);
  if (entries.length === 0) {
    throw new Error('pyric: --allowed-host cannot be empty.');
  }
  return parseAllowedHostsStrict(entries).map((pattern) => pattern.raw);
}

/**
 * Parse `--allow-remote-peers[=<cidr,...|any|loopback>]` or `PYRIC_ALLOW_REMOTE_PEERS`.
 * A bare boolean flag (`true`) defaults to `'any'` only when explicit, rejecting empty strings.
 */
export function parseAllowRemotePeersInput(raw: string | boolean): 'loopback' | 'any' | string[] {
  if (raw === false) return 'loopback';
  if (raw === true) return 'any';
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === '0' || trimmed === 'false' || trimmed === 'loopback') {
    return 'loopback';
  }
  if (trimmed === 'any') return 'any';
  const entries = splitCsvValues(raw);
  parseAllowPeersSetting(entries);
  return entries;
}

/**
 * Parse `--trust-proxy[=loopback|<cidr,...>|false]` or `PYRIC_TRUST_PROXY`.
 * A bare boolean flag (`true`) defaults to `'loopback'`.
 */
export function parseTrustProxyInput(raw: string | boolean): false | 'loopback' | string[] {
  if (raw === false) return false;
  if (raw === true) return 'loopback';
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === '0' || trimmed === 'false' || trimmed === 'off' || trimmed === 'none') {
    return false;
  }
  if (trimmed === 'loopback' || trimmed === '1' || trimmed === 'true') {
    return 'loopback';
  }
  const entries = splitCsvValues(raw);
  parseTrustProxySetting(entries);
  return entries;
}
