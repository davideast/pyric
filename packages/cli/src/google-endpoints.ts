/**
 * The single shared source of Google/Firebase production endpoint hosts.
 *
 * The throwing frontend build check (`cli/inlined-sdk-scanner.ts`) greps
 * served assets for the narrower SDK fingerprint subset below.
 *
 * It lives at the package root, not under `cli/` or `register/`, so callers
 * import it without a cycle, and it has zero imports so it stays cheap.
 *
 * Membership rule: a host belongs here only if it is real-SDK-only, meaning it
 * can never legitimately be contacted by a sandbox-clean app (whose Firebase
 * traffic all routes to the local `/__pyric/*` namespace).
 */

/** One production endpoint host and the service it belongs to. */
export interface GoogleEndpoint {
  /** Registrable host or host suffix. Matched by label-boundary suffix. */
  readonly host: string;
  /** Human-readable service name, used verbatim in scanner messages. */
  readonly service: string;
  /**
   * True when the host string is evidence that real Firebase SDK code was
   * compiled into a build artifact. Only these hosts feed the throwing
   * frontend build check, because that check fails a build outright.
   *
   * False for a host an ordinary app can carry without any SDK: a public Cloud
   * Storage asset URL, a bare callable URL on `cloudfunctions.net`, a
   * `databaseURL` config literal on `firebaseio.com`, a Vertex AI call from a
   * hand-written client, a server-side FCM send, or an admin control plane.
   */
  readonly fingerprint: boolean;
}

/** The host the Firebase AI Logic SDK (`firebase/ai`) calls. */
const FIREBASE_AI_LOGIC_HOST = 'firebasevertexai.googleapis.com';

export const GOOGLE_ENDPOINT_CATALOG: readonly GoogleEndpoint[] = [
  // Identity. Both are reached by the Auth SDK and by nothing else.
  { host: 'identitytoolkit.googleapis.com', service: 'Firebase Authentication', fingerprint: true },
  {
    host: 'securetoken.googleapis.com',
    service: 'Firebase Authentication (token refresh)',
    fingerprint: true,
  },
  // Firestore.
  { host: 'firestore.googleapis.com', service: 'Cloud Firestore', fingerprint: true },
  // Realtime Database. `firebaseio.com` is the legacy/us-central1 host and is
  // also the shape of a `databaseURL` config literal, so it does not
  // fingerprint a build; `firebasedatabase.app` is the regional host.
  { host: 'firebaseio.com', service: 'Realtime Database', fingerprint: false },
  { host: 'firebasedatabase.app', service: 'Realtime Database', fingerprint: true },
  // Cloud Storage. Both hosts appear in ordinary download and asset URLs, so
  // neither fingerprints a build.
  {
    host: 'firebasestorage.googleapis.com',
    service: 'Cloud Storage for Firebase',
    fingerprint: false,
  },
  { host: 'storage.googleapis.com', service: 'Cloud Storage', fingerprint: false },
  // Cloud Functions: `cloudfunctions.net` is the data plane the callable SDK
  // hits (`https://<region>-<project>.cloudfunctions.net/<fn>`) and is equally
  // the shape of a hand-written fetch; `cloudfunctions.googleapis.com` is the
  // admin/control plane, reached by deployment tooling.
  { host: 'cloudfunctions.net', service: 'Cloud Functions', fingerprint: false },
  {
    host: 'cloudfunctions.googleapis.com',
    service: 'Cloud Functions (control plane)',
    fingerprint: false,
  },
  // Messaging. `fcmregistrations` issues the token and only the SDK calls it;
  // `fcm.googleapis.com` is the server-side send endpoint. Installations is
  // the ID prerequisite every FCM/Remote Config bundle carries.
  {
    host: 'fcmregistrations.googleapis.com',
    service: 'Firebase Cloud Messaging (registration)',
    fingerprint: true,
  },
  { host: 'fcm.googleapis.com', service: 'Firebase Cloud Messaging', fingerprint: false },
  {
    host: 'firebaseinstallations.googleapis.com',
    service: 'Firebase Installations',
    fingerprint: true,
  },
  // AI. The Firebase AI Logic host is SDK-only; raw Vertex AI is reachable
  // from any HTTP client.
  { host: FIREBASE_AI_LOGIC_HOST, service: 'Firebase AI Logic', fingerprint: true },
  { host: 'aiplatform.googleapis.com', service: 'Vertex AI', fingerprint: false },
];

/**
 * The subset that is evidence of inlined SDK code, and the only set the
 * throwing frontend build check may grep for. See
 * {@link GoogleEndpoint.fingerprint}.
 */
export const SDK_FINGERPRINT_HOSTS: readonly string[] = GOOGLE_ENDPOINT_CATALOG.filter(
  (e) => e.fingerprint,
).map((e) => e.host);

/**
 * Catalog entries longest host first, so the narrowest suffix wins regardless
 * of the order the entries are authored in
 * (`firebasestorage.googleapis.com` before `storage.googleapis.com`).
 */
const CATALOG_BY_SPECIFICITY: readonly GoogleEndpoint[] = [...GOOGLE_ENDPOINT_CATALOG].sort(
  (a, b) => b.host.length - a.host.length,
);

/**
 * Trim, lowercase, drop a trailing root dot, and write an IP address in one
 * form. The one spelling of a hostname that every comparison in the scanner and
 * the catalog uses.
 *
 * The system resolver connects to `2852039166`, `0xa9fea9fe`, `169.254.43518`
 * and `::ffff:169.254.169.254` as `169.254.169.254`, so comparing the text a
 * caller wrote would let any of them past an entry for the metadata server.
 */
export function normalizeHostname(value: string): string {
  const text = value.trim().toLowerCase().replace(/\.$/, '');
  return canonicalIpAddress(text) ?? text;
}

/** Characters the URL parser reads as something other than part of a host. */
const URL_DELIMITERS = /[\s/?#@\\%]/;

/** A host the URL parser could read as IPv4: digits, dots and hex. */
const IPV4_CANDIDATE = /^[0-9a-fx.]+$/;

const DOTTED_QUAD = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * `text` written the way the URL parser writes an IP address: a dotted quad
 * for every IPv4 form, and for IPv6 the compressed form without brackets, or
 * its IPv4 address when it embeds IPv4 via IPv4-mapped (`::ffff:a.b.c.d`),
 * IPv4-translated (`::ffff:0:a.b.c.d`), NAT64 (`64:ff9b::a.b.c.d`), or
 * IPv4-compatible (`::a.b.c.d`) prefixes. `undefined` for anything that is
 * not an IP address, which stays as text.
 */
function canonicalIpAddress(text: string): string | undefined {
  if (text.includes(':')) return canonicalIpv6Text(text);
  if (text.length === 0 || URL_DELIMITERS.test(text)) return undefined;
  if (!IPV4_CANDIDATE.test(text)) return undefined;
  const hostname = parsedHostname(text);
  if (hostname !== undefined && DOTTED_QUAD.test(hostname)) return hostname;
  return undefined;
}

/** A trailing IPv6 zone id, `%lo`, or `%25lo` as a URL writes it. */
const ZONE_ID = /%(?:25)?[^%]*$/;

/**
 * IPv6 text without its brackets and zone id. Node and the kernel accept
 * `::ffff:a9fe:a9fe%lo` and reach the IPv4 address, but the URL parser rejects
 * a zone id, so it comes off before parsing.
 */
function canonicalIpv6Text(text: string): string | undefined {
  const bare = text.replace(/^\[(.*)\]$/, '$1').replace(ZONE_ID, '');
  if (bare.length === 0 || URL_DELIMITERS.test(bare)) return undefined;
  return canonicalIpv6(bare);
}

const HEX_HEXTET_PATTERN = /^[0-9a-f]{1,4}$/;

function parseHextetGroup(part: string): number[] | undefined {
  if (part === '') return [];
  const pieces = part.split(':');
  const out: number[] = [];
  for (const piece of pieces) {
    if (!HEX_HEXTET_PATTERN.test(piece)) return undefined;
    out.push(Number.parseInt(piece, 16));
  }
  return out;
}

function parseIpv6Hextets(address: string): readonly number[] | undefined {
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const left = parseHextetGroup(halves[0] ?? '');
  if (left === undefined) return undefined;
  if (halves.length === 1) {
    return left.length === 8 ? left : undefined;
  }
  const right = parseHextetGroup(halves[1] ?? '');
  if (right === undefined) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  const zeros: number[] = [];
  for (let i = 0; i < missing; i += 1) {
    zeros.push(0);
  }
  return [...left, ...zeros, ...right];
}

function embeddedIpv4FromHextets(hextets: readonly number[]): string | undefined {
  const h0 = hextets[0];
  const h1 = hextets[1];
  const h2 = hextets[2];
  const h3 = hextets[3];
  const h4 = hextets[4];
  const h5 = hextets[5];
  const h6 = hextets[6];
  const h7 = hextets[7];
  if (
    h0 === undefined ||
    h1 === undefined ||
    h2 === undefined ||
    h3 === undefined ||
    h4 === undefined ||
    h5 === undefined ||
    h6 === undefined ||
    h7 === undefined
  ) {
    return undefined;
  }
  const isIpv4Mapped =
    h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff;
  const isIpv4Translated =
    h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0;
  const isNat64WellKnown =
    h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0;
  // IPv4-compatible (`::a.b.c.d`): require high octet >= 1 so `::`, `::1`, and
  // single-hextet IPv6 addresses stay IPv6 while routable IPv4 values unwrap.
  const isIpv4Compatible =
    h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 >= 0x0100;

  if (!isIpv4Mapped && !isIpv4Translated && !isNat64WellKnown && !isIpv4Compatible) {
    return undefined;
  }
  return `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
}

function canonicalIpv6(bare: string): string | undefined {
  const hostname = parsedHostname(`[${bare}]`);
  if (hostname === undefined) return undefined;
  const address = hostname.replace(/^\[(.*)\]$/, '$1');
  const hextets = parseIpv6Hextets(address);
  if (hextets === undefined) return address;
  return embeddedIpv4FromHextets(hextets) ?? address;
}

/** The hostname the WHATWG URL parser reads from `host`, or `undefined`. */
function parsedHostname(host: string): string | undefined {
  try {
    return new URL(`http://${host}/`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Label-boundary suffix match: `x.example.com` matches `example.com`,
 * `notexample.com` does not.
 */
export function matchesHostSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/**
 * Resolve a hostname to its catalog entry, or `undefined` when it is not a
 * known production endpoint. Matches the exact host or a subdomain of it, on
 * label boundaries, narrowest suffix first.
 */
export function lookupGoogleEndpoint(hostname: string): GoogleEndpoint | undefined {
  const host = normalizeHostname(hostname);
  return CATALOG_BY_SPECIFICITY.find((e) => matchesHostSuffix(host, e.host));
}
