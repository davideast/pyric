/**
 * The single shared source of Google/Firebase production endpoint hosts.
 *
 * Three readers consume this table and they must never drift apart:
 *  - the runtime net guard (`register/net-guard.ts`), which matches every
 *    catalog host on egress from a pyric-launched child;
 *  - the warn-only pre-flight scan at child launch, which greps backend build
 *    output for every catalog host;
 *  - the throwing frontend build check in `cli/serve.ts`, which greps served
 *    assets for the narrower SDK fingerprint subset below.
 *
 * It lives at the package root, not under `cli/` or `register/`, so all three
 * import it without a cycle, and it has zero imports so the `--import`ed
 * register entry stays cheap.
 *
 * Membership rule: a host belongs here only if it is real-SDK-only, meaning it
 * can never legitimately be contacted by a sandbox-clean app (whose Firebase
 * traffic all routes to the local `/__pyric/*` namespace). User-configured
 * upstreams (BYOK AI base URLs, app APIs) are handled by the guard's
 * allowlist, not by omission from this table.
 */

/** One production endpoint host and the service it belongs to. */
export interface GoogleEndpoint {
  /** Registrable host or host suffix. Matched by label-boundary suffix. */
  readonly host: string;
  /** Human-readable service name, used verbatim in guard and scanner messages. */
  readonly service: string;
  /**
   * Blocked from day one rather than warn-first. Reserved for egress that is
   * never explainable as a false positive, currently only the GCE/GKE metadata
   * server, whose only purpose here would be credential theft.
   */
  readonly alwaysBlock?: true;
  /**
   * True when the host string is evidence that real Firebase SDK code was
   * compiled into a build artifact. Only these hosts feed the throwing
   * frontend build check, because that check fails a build outright.
   *
   * False for a host an ordinary app can carry without any SDK: a public Cloud
   * Storage asset URL, a bare callable URL on `cloudfunctions.net`, a
   * `databaseURL` config literal on `firebaseio.com`, a Vertex AI call from a
   * hand-written client, a server-side FCM send, an admin control plane, or an
   * infrastructure reference to the metadata server. The net guard and the
   * warn-only pre-flight scan still match all of them.
   */
  readonly fingerprint: boolean;
}

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
  { host: 'firebasevertexai.googleapis.com', service: 'Firebase AI Logic', fingerprint: true },
  { host: 'aiplatform.googleapis.com', service: 'Vertex AI', fingerprint: false },
  // Credential exfiltration target. Never a false positive on the wire, and
  // never evidence that an SDK was inlined.
  {
    host: '169.254.169.254',
    service: 'GCE metadata server',
    alwaysBlock: true,
    fingerprint: false,
  },
  {
    host: 'metadata.google.internal',
    service: 'GCE metadata server',
    alwaysBlock: true,
    fingerprint: false,
  },
];

/** Every catalog host: the net guard's and the pre-flight scan's match set. */
export const GOOGLE_ENDPOINT_HOSTS: readonly string[] = GOOGLE_ENDPOINT_CATALOG.map((e) => e.host);

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

/** Trim, lowercase, and drop a trailing root dot. The one spelling of a
 *  hostname that every comparison in the guard and the catalog uses. */
export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
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
