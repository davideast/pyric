/**
 * The SINGLE SHARED SOURCE of Google/Firebase production endpoint hosts.
 *
 * Two interlocks read this table and they must never drift apart:
 *  - the artifact scanner (`cli/serve.ts` → `scanForInlinedFirebase`), which
 *    greps build output for these hosts as a fingerprint that the real
 *    Firebase SDK was inlined into a bundle (such a bundle cannot be
 *    sandboxed — its calls reach LIVE Google, not `/__pyric/*`);
 *  - the runtime net guard (`register/net-guard.ts`), which matches the same
 *    hosts on egress from a pyric-launched child.
 *
 * It lives at the package root — not under `cli/` or `register/` — so both
 * sides import it without a cycle, and it deliberately has ZERO imports so
 * the `--import`ed register entry stays cheap.
 *
 * Membership rule: a host belongs here only if it is REAL-SDK-ONLY, i.e. it
 * can never legitimately be contacted by a sandbox-clean app (whose Firebase
 * traffic all routes to the local `/__pyric/*` namespace). User-configured
 * upstreams (BYOK AI base URLs, app APIs) are handled by the guard's
 * allowlist, not by omission from this table.
 */

/** One production endpoint host and the service it belongs to. */
export interface GoogleEndpoint {
  /** Registrable host or host suffix. Matched by label-boundary suffix. */
  readonly host: string;
  /** Human-readable service name, used verbatim in guard/scanner messages. */
  readonly service: string;
  /**
   * Blocked from day one rather than warn-first. Reserved for egress that is
   * never explainable as a false positive — currently only the GCE/GKE
   * metadata server, whose only purpose here would be credential theft.
   */
  readonly alwaysBlock?: true;
  /**
   * Guard-relevant on the wire, but too generic to FINGERPRINT a build
   * artifact with: the string legitimately appears in apps that never touch
   * the Firebase SDK (a public GCS asset URL). Excluded from
   * {@link INLINE_FINGERPRINT_HOSTS} so the scanner — which fails a build
   * hard — cannot be tripped by an ordinary image link.
   */
  readonly generic?: true;
}

/**
 * Ordered most-specific-first so a plain linear scan in `lookupGoogleEndpoint`
 * returns the narrowest match (`firebasestorage.` before `storage.`).
 */
export const GOOGLE_ENDPOINT_CATALOG: readonly GoogleEndpoint[] = [
  // Identity
  { host: 'identitytoolkit.googleapis.com', service: 'Firebase Authentication' },
  { host: 'securetoken.googleapis.com', service: 'Firebase Authentication (token refresh)' },
  // Firestore
  { host: 'firestore.googleapis.com', service: 'Cloud Firestore' },
  // Realtime Database — `firebaseio.com` is the legacy/us-central1 host,
  // `firebasedatabase.app` the regional one.
  { host: 'firebaseio.com', service: 'Realtime Database' },
  { host: 'firebasedatabase.app', service: 'Realtime Database' },
  // Cloud Storage. The Firebase-flavored host must precede the raw GCS host:
  // `firebasestorage.googleapis.com` also suffix-matches `storage.googleapis.com`.
  { host: 'firebasestorage.googleapis.com', service: 'Cloud Storage for Firebase' },
  { host: 'storage.googleapis.com', service: 'Cloud Storage', generic: true },
  // Cloud Functions: `cloudfunctions.net` is the data plane the callable SDK
  // hits (`https://<region>-<project>.cloudfunctions.net/<fn>`);
  // `cloudfunctions.googleapis.com` is the admin/control plane.
  { host: 'cloudfunctions.net', service: 'Cloud Functions' },
  { host: 'cloudfunctions.googleapis.com', service: 'Cloud Functions (control plane)' },
  // Messaging. `fcmregistrations` issues the token, `fcm` sends; Installations
  // is the ID prerequisite every FCM/Remote Config bundle carries.
  { host: 'fcmregistrations.googleapis.com', service: 'Firebase Cloud Messaging (registration)' },
  { host: 'fcm.googleapis.com', service: 'Firebase Cloud Messaging' },
  { host: 'firebaseinstallations.googleapis.com', service: 'Firebase Installations' },
  // AI
  { host: 'firebasevertexai.googleapis.com', service: 'Firebase AI Logic' },
  { host: 'aiplatform.googleapis.com', service: 'Vertex AI' },
  // Credential exfiltration target — never a false positive.
  { host: '169.254.169.254', service: 'GCE metadata server', alwaysBlock: true },
  { host: 'metadata.google.internal', service: 'GCE metadata server', alwaysBlock: true,
    // DNS name for the same server — must never feed the throwing artifact scanner
    generic: true,
  },
];

/** Every catalog host, in catalog order — the net guard's full match set. */
export const GOOGLE_ENDPOINT_HOSTS: readonly string[] = GOOGLE_ENDPOINT_CATALOG.map((e) => e.host);

/**
 * The subset safe to grep build artifacts for (see {@link GoogleEndpoint.generic}).
 * Used by the artifact scanner, which fails a build on a hit.
 */
export const INLINE_FINGERPRINT_HOSTS: readonly string[] = GOOGLE_ENDPOINT_CATALOG.filter(
  (e) => !e.generic,
).map((e) => e.host);

/**
 * Resolve a hostname to its catalog entry, or `undefined` when it is not a
 * known production endpoint. Matches the exact host or a subdomain of it, on
 * label boundaries — `us-central1-x.cloudfunctions.net` matches
 * `cloudfunctions.net`, but `evilfirebaseio.com` does not match
 * `firebaseio.com`.
 */
export function lookupGoogleEndpoint(hostname: string): GoogleEndpoint | undefined {
  const h = hostname.trim().toLowerCase().replace(/\.$/, '');
  return GOOGLE_ENDPOINT_CATALOG.find((e) => h === e.host || h.endsWith(`.${e.host}`));
}
