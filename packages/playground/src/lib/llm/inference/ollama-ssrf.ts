/**
 * SSRF guard for the page-direct Ollama / OpenAI-compatible provider.
 *
 * Context (#766): the `ollama` provider treats the caller's BYOK field
 * as an outbound base URL and fetches it. On the BROWSER page-direct
 * transport that's exactly the intended behaviour — the URL points at
 * the end-user's OWN machine (`http://localhost:11434`), so http and
 * loopback are legitimate. The danger is only if the provider is ever
 * reached SERVER-SIDE (a Cloud Function / Astro SSR context): there the
 * same fetch runs with the server's network reachability and an
 * attacker-supplied base URL becomes an SSRF primitive against internal
 * hosts (GCP metadata `169.254.169.254`, RTDB emulators, RFC1918
 * neighbours, …).
 *
 * `ollama` is deliberately NOT registered in the server relay (#760,
 * asserted in `src/lib/server/server-providers.ts`), so this is
 * defense-in-depth: if the provider is ever invoked in a non-browser
 * runtime, `assertSafeServerBaseUrl` rejects internal targets.
 *
 * This module is dependency-free and isomorphic so it can be imported
 * from the browser bundle without dragging in `node:*`. The optional
 * DNS resolution used to catch hostnames that RESOLVE to internal IPs
 * is injected by the caller (the Node-only provider path passes
 * `dns.lookup`); the pure IP-literal checks need no network and are
 * fully unit-testable.
 */

/** Result of classifying a single resolved address. */
export interface AddressClassification {
  blocked: boolean;
  reason?: string;
}

/** Expand an IPv4 dotted-quad to its 32-bit unsigned integer, or null
 *  if `host` is not a valid IPv4 literal. */
function ipv4ToInt(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map((p) => Number(p));
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inCidr(ip: number, netStr: string, bits: number): boolean {
  const net = ipv4ToInt(netStr)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (net & mask);
}

/**
 * Classify a resolved host/address as safe or blocked for a
 * server-side outbound fetch. Handles IPv4 literals (private/loopback/
 * link-local/metadata ranges) and the obvious IPv6 internal forms; a
 * bare hostname the caller couldn't resolve is treated as blocked when
 * it matches a known metadata alias, otherwise passed through for the
 * caller's DNS step to classify.
 */
export function classifyAddress(host: string): AddressClassification {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');

  // Metadata service aliases — string-match before any numeric parse.
  if (h === 'metadata' || h === 'metadata.google.internal' || h === 'metadata.internal') {
    return { blocked: true, reason: 'metadata-host' };
  }

  const v4 = ipv4ToInt(h);
  if (v4 !== null) {
    if (inCidr(v4, '127.0.0.0', 8)) return { blocked: true, reason: 'loopback' };
    if (inCidr(v4, '10.0.0.0', 8)) return { blocked: true, reason: 'rfc1918' };
    if (inCidr(v4, '172.16.0.0', 12)) return { blocked: true, reason: 'rfc1918' };
    if (inCidr(v4, '192.168.0.0', 16)) return { blocked: true, reason: 'rfc1918' };
    if (inCidr(v4, '169.254.0.0', 16)) return { blocked: true, reason: 'link-local' };
    if (inCidr(v4, '100.64.0.0', 10)) return { blocked: true, reason: 'cgnat' };
    if (inCidr(v4, '0.0.0.0', 8)) return { blocked: true, reason: 'this-network' };
    return { blocked: false };
  }

  // IPv6 internal forms.
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return { blocked: true, reason: 'loopback' };
  if (h === '::' || h === '0:0:0:0:0:0:0:0') return { blocked: true, reason: 'unspecified' };
  if (/^fe80:/i.test(h)) return { blocked: true, reason: 'link-local' };
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return { blocked: true, reason: 'unique-local' };
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — classify the embedded v4.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (mapped) return classifyAddress(mapped[1]!);

  // A DNS name we can't classify here — the caller resolves it.
  return { blocked: false };
}

/** Injectable DNS resolver — returns the addresses a hostname resolves
 *  to. The Node provider path passes a `dns.lookup`-backed impl; unit
 *  tests either omit it (IP-literal cases) or stub it. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export class SsrfBlockedError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Assert a base URL is safe to fetch from a SERVER context. Throws
 * `SsrfBlockedError` on a non-http(s) scheme or an internal target.
 * IPv4/IPv6 literals are checked directly; a hostname is resolved via
 * `resolve` (when supplied) and every returned address is checked, so a
 * DNS name that points at `169.254.169.254` is caught too.
 */
export async function assertSafeServerBaseUrl(
  rawUrl: string,
  resolve?: HostResolver,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`invalid base URL: ${rawUrl}`, 'invalid-url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`disallowed scheme: ${url.protocol}`, 'scheme');
  }
  const host = url.hostname;
  const literal = classifyAddress(host);
  if (literal.blocked) {
    throw new SsrfBlockedError(`blocked host ${host} (${literal.reason})`, literal.reason!);
  }
  // If it's an IP literal it's already fully classified; only resolve
  // real hostnames.
  const isLiteral = ipv4ToInt(host) !== null || host.includes(':');
  if (!isLiteral && resolve) {
    const addrs = await resolve(host);
    for (const addr of addrs) {
      const c = classifyAddress(addr);
      if (c.blocked) {
        throw new SsrfBlockedError(
          `host ${host} resolves to blocked address ${addr} (${c.reason})`,
          c.reason!,
        );
      }
    }
  }
}
