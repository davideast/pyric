/**
 * Every Google host, for the network guard once the real-admin tripwire fires
 * (#1475).
 *
 * The endpoint catalog (`./google-endpoints.ts`) lists the hosts a Firebase
 * SDK reaches, and a plain `block` guard refuses those. A real
 * `firebase-admin` holding this machine's credentials reaches more: OAuth
 * token exchange, Security Rules releases, Remote Config templates, Cloud
 * Tasks, and whatever Google adds next. Once the tripwire has seen one, the
 * guard refuses every host below instead of keeping a list that lags Google's
 * APIs. `PYRIC_GUARD_ALLOW` is then the only way through, and never for the
 * metadata server.
 */
import {
  GOOGLE_ENDPOINT_CATALOG,
  lookupGoogleEndpoint,
  matchesHostSuffix,
  normalizeHostname,
  type GoogleEndpoint,
} from './google-endpoints.js';

/** The suffixes every Google API and Firebase backend answers on. */
export const GOOGLE_HOST_SUFFIXES: readonly GoogleEndpoint[] = [
  { host: 'googleapis.com', service: 'a Google API', fingerprint: false },
  { host: 'firebaseio.com', service: 'Realtime Database', fingerprint: false },
  { host: 'firebasedatabase.app', service: 'Realtime Database', fingerprint: false },
  { host: 'cloudfunctions.net', service: 'Cloud Functions', fingerprint: false },
  { host: 'run.app', service: 'Cloud Run', fingerprint: false },
];

/**
 * The GCE metadata server under each name a VM resolves: the link-local IPv4
 * address (every respelling normalizes to it), its DNS name, the bare short
 * name GCE's resolver answers, and the IPv6 address of an IPv6-only VM.
 */
export const METADATA_SERVER_HOSTS: readonly GoogleEndpoint[] = [
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  'fd20:ce::254',
].map((host) => ({ host, service: 'GCE metadata server', alwaysBlock: true, fingerprint: false }));

/** The suffixes as the guard's lines write them: `*.googleapis.com, ... and *.run.app`. */
export function describeGoogleHostSuffixes(): string {
  const patterns = GOOGLE_HOST_SUFFIXES.map((entry) => `*.${entry.host}`);
  const last = patterns.pop();
  return `${patterns.join(', ')} and ${last}`;
}

/** The metadata server's names, comma separated. */
export function describeMetadataServerHosts(): string {
  return METADATA_SERVER_HOSTS.map((entry) => entry.host).join(', ');
}

/** The catalog's hosts, comma separated, in the order the catalog lists them. */
export function describeCatalogHosts(): string {
  return GOOGLE_ENDPOINT_CATALOG.map((entry) => entry.host).join(', ');
}

/**
 * The entry for any Google host, or `undefined` for every other host. A
 * catalog host keeps its catalog entry, so its service name and `alwaysBlock`
 * carry over. The metadata server's names match exactly; the suffixes match
 * on label boundaries.
 */
export function lookupGoogleHost(hostname: string): GoogleEndpoint | undefined {
  const catalogEntry = lookupGoogleEndpoint(hostname);
  if (catalogEntry !== undefined) return catalogEntry;
  const host = normalizeHostname(hostname);
  const metadataEntry = METADATA_SERVER_HOSTS.find((entry) => entry.host === host);
  if (metadataEntry !== undefined) return metadataEntry;
  return GOOGLE_HOST_SUFFIXES.find((entry) => matchesHostSuffix(host, entry.host));
}
