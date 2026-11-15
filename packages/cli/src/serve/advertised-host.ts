/**
 * Client-facing host and URL formatting for sandbox servers.
 *
 * A server bound to a wildcard address (`0.0.0.0`, `::`, `[::]`, or an
 * equivalent zero address) listens on every interface, but its own
 * DNS-rebinding guard rejects requests whose `Host` header carries a wildcard
 * address. Every client-facing URL (`.pyric/serve.json`, `/__pyric/init.json`,
 * startup banners, and child launchers) therefore advertises `localhost`
 * instead, while the listener and Host guard keep the raw bind host.
 */

/** Remove surrounding square brackets from an IPv6 host literal, if present. */
export function stripHostBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

/** Format a URL `port` string as `:port` when non-empty, or `''` otherwise. */
export function portSuffix(port: string): string {
  if (port === '') return '';
  return `:${port}`;
}

function isWildcardHost(host: string): boolean {
  const unwrapped = stripHostBrackets(host.trim());
  const clean = unwrapped.replace(/\.+$/, '').toLowerCase();
  if (clean === '0' || clean === '0.0.0.0') return true;
  if (!clean.includes(':')) return false;
  try {
    const canonical = new URL(`http://[${clean}]`).hostname;
    return canonical === '[::]' || canonical === '[::ffff:0:0]';
  } catch {
    return /^[0:]+$/.test(clean);
  }
}

/**
 * Resolve a bind host to a connectable client-facing hostname. Wildcard bind
 * addresses (`0.0.0.0`, `::`, `[::]`, `::ffff:0.0.0.0`) and empty strings map
 * to `localhost`; explicit non-wildcard hosts are preserved verbatim.
 */
export function advertisedHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed === '' || isWildcardHost(trimmed)) return 'localhost';
  return trimmed;
}

/**
 * Format a bind host for placement inside a URL authority: wildcard binds map
 * to `localhost`, and bare IPv6 literals (such as `::1`) are wrapped in square
 * brackets.
 */
export function formatUrlHost(host: string): string {
  const resolved = advertisedHost(host);
  const isBareIpv6 = resolved.includes(':') && !resolved.startsWith('[');
  if (isBareIpv6) return `[${resolved}]`;
  return resolved;
}

function authorityAndPathPart(rawUrl: string, protocolLength: number): string {
  const afterScheme = rawUrl.trimStart().slice(protocolLength + 2);
  const queryOrHashIndex = afterScheme.search(/[?#]/);
  if (queryOrHashIndex === -1) return afterScheme;
  return afterScheme.slice(0, queryOrHashIndex);
}

/**
 * Rewrite a URL whose hostname is a wildcard bind address to use `localhost`
 * while preserving scheme, port, path, query, and fragment. Non-wildcard URLs
 * and unparseable strings are returned unchanged.
 */
export function advertisedUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!isWildcardHost(parsed.hostname)) return rawUrl;
  const hasExplicitSlash = authorityAndPathPart(rawUrl, parsed.protocol.length).includes('/');
  let pathPart = parsed.pathname;
  if (parsed.pathname === '/' && !hasExplicitSlash) {
    pathPart = '';
  }
  return `${parsed.protocol}//localhost${portSuffix(parsed.port)}${pathPart}${parsed.search}${parsed.hash}`;
}
