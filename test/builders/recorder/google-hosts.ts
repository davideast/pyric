/**
 * Which hosts the builder recorder treats as Google. Pyric's own catalog
 * (`packages/cli/src/google-endpoints.ts`) decides first, in its one spelling
 * of a host. A wider list of Google suffixes catches what the catalog does not
 * name: a Google host outside the catalog is a guard catalog gap, the class of
 * miss #1475 found (`oauth2.googleapis.com`, `firebaserules.googleapis.com`).
 *
 * The recorder preload (`node-egress.mjs`) imports this file under Node's type
 * stripping, so it uses only erasable TypeScript and imports with `.ts`.
 */
import { lookupGoogleEndpoint, matchesHostSuffix, normalizeHostname } from '../../../packages/cli/src/google-endpoints.ts';

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
];

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

function underWiderSuffix(host: string): boolean {
  return GOOGLE_HOST_SUFFIXES.some((suffix) => matchesHostSuffix(host, suffix));
}

/** Classifies a hostname or IP address, however it is spelled. */
export function classifyHost(value: string): HostClass {
  const host = normalizeHostname(value);
  const metadata = METADATA_HOSTS.includes(host);
  const endpoint = lookupGoogleEndpoint(host);
  if (endpoint !== undefined) return { host, google: true, service: endpoint.service, catalogGap: false, metadata };
  const isWiderGoogle = underWiderSuffix(host);
  return { host, google: isWiderGoogle, catalogGap: isWiderGoogle, metadata };
}

/** The recorder refuses every Google host and the metadata server. */
export function isRefusedHost(value: string): boolean {
  const verdict = classifyHost(value);
  return verdict.google || verdict.metadata;
}

const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

/** Loopback, the only destination a builder run may reach. */
export function isLoopbackHost(value: string): boolean {
  const host = normalizeHostname(value);
  return LOOPBACK_HOSTS.includes(host) || matchesHostSuffix(host, 'localhost');
}
