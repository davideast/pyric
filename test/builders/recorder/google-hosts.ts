/**
 * Which hosts the builder recorder treats as Google. Pyric's own catalog
 * (`packages/cli/src/google-endpoints.ts`) decides first, in its one spelling
 * of a host. Wider rules catch what the catalog does not name: a list of Google
 * suffixes, Google's country domains (`google.de`), and Google's own address
 * ranges (`google-addresses.ts`). A Google host outside the catalog is a guard
 * catalog gap, the class of
 * miss #1475 found (`oauth2.googleapis.com`, `firebaserules.googleapis.com`).
 *
 * The recorder preload (`node-egress.mjs`) imports this file under Node's type
 * stripping, so it uses only erasable TypeScript and imports with `.ts`.
 */
import { lookupGoogleEndpoint, matchesHostSuffix, normalizeHostname } from '../../../packages/cli/src/google-endpoints.ts';
import { isGoogleAddress } from './google-addresses.ts';

/** Google and Firebase registrable suffixes, wider than pyric's catalog. */
export const GOOGLE_HOST_SUFFIXES: readonly string[] = [
  'googleapis.com',
  'google.com',
  'gstatic.com',
  'firebaseio.com',
  'firebasedatabase.app',
  'firebaseapp.com',
  'web.app',
  'firebasestorage.app',
  'appspot.com',
  'cloudfunctions.net',
  'run.app',
  'googleusercontent.com',
  'metadata.google.internal',
  'app-measurement.com',
  'google-analytics.com',
  'googletagmanager.com',
  'googleadservices.com',
  'googlesyndication.com',
  'doubleclick.net',
  'gvt1.com',
  'gvt2.com',
  'recaptcha.net',
  'youtube.com',
  'ytimg.com',
  'googlevideo.com',
  'ggpht.com',
  // Google's own top-level domains: `pki.goog`, `dns.google`.
  'goog',
  'google',
];

/** Google's country domains: `google.de`, `google.co.uk`, `google.com.au`. */
const GOOGLE_COUNTRY_DOMAIN = /(?:^|\.)google\.(?:com?\.)?[a-z]{2}$/;

/** The GCE metadata server, by address and by name. */
const METADATA_HOSTS: readonly string[] = ['169.254.169.254', 'metadata.google.internal'];

/** What the recorder knows about one host. */
export interface HostClass {
  /** The host in the catalog's one spelling. */
  readonly host: string;
  /** In pyric's catalog or under a wider Google suffix. */
  readonly google: boolean;
  /** The catalog's service name, when the catalog lists the host. */
  readonly service?: string;
  /** A Google host pyric's catalog does not list. */
  readonly catalogGap: boolean;
  /** The GCE metadata server. */
  readonly metadata: boolean;
}

/** Google by a rule wider than pyric's catalog: a suffix, a country domain, or one of Google's own addresses. */
function isWiderGoogle(host: string): boolean {
  const isUnderSuffix = GOOGLE_HOST_SUFFIXES.some((suffix) => matchesHostSuffix(host, suffix));
  return isUnderSuffix || GOOGLE_COUNTRY_DOMAIN.test(host) || isGoogleAddress(host);
}

/** Classifies a hostname or IP address, however it is spelled. */
export function classifyHost(value: string): HostClass {
  const host = normalizeHostname(value);
  const metadata = METADATA_HOSTS.includes(host);
  const endpoint = lookupGoogleEndpoint(host);
  if (endpoint !== undefined) return { host, google: true, service: endpoint.service, catalogGap: false, metadata };
  const google = isWiderGoogle(host);
  return { host, google, catalogGap: google, metadata };
}

/**
 * Google hosts and the metadata server. The Node recorder refuses each one,
 * and each one in a run's record is a finding. The one predicate for every
 * layer: the recorder preload, the namespace resolver and the verdict.
 */
export function isGoogleOrMetadata(verdict: { google?: boolean; metadata?: boolean }): boolean {
  return verdict.google === true || verdict.metadata === true;
}

/** Whether the recorder refuses `value`, however it is spelled. */
export function isRefusedHost(value: string): boolean {
  return isGoogleOrMetadata(classifyHost(value));
}

const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

/** Loopback, the only destination a builder run may reach. */
export function isLoopbackHost(value: string): boolean {
  const host = normalizeHostname(value);
  return LOOPBACK_HOSTS.includes(host) || matchesHostSuffix(host, 'localhost');
}
