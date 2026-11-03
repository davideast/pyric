/**
 * The places a server-side Google access token comes from: the list the
 * network guard refuses (ADR 0022, decision 2).
 *
 * Server code can't act with admin authority until it holds a Google access
 * token, and the Firebase client SDK never asks for one: it sends the
 * project's API key and the signed-in user's ID token, so production's rules
 * decide what it can do. So the guard refuses these destinations and lets
 * every other host through without a report: Firebase data hosts, Google
 * Fonts, `*.run.app`, `identitytoolkit` and `securetoken` all pass.
 *
 * Checked against google-auth-library 10.9.0 and 9.15.1, gtoken 7.1.0 and
 * gcp-metadata 8.1.2 and 6.1.1. `test/google-token-endpoints.test.ts` reads the
 * installed copies of those libraries and fails when one names a token URL
 * this list doesn't refuse.
 *
 * Left off on purpose: `accounts.google.com` (a consent URL for a browser, and
 * gtoken's revoke), `www.googleapis.com/oauth2/v1/certs` and `/v3/certs`
 * (public keys), and the AWS addresses, whose credentials become a Google
 * token only at `sts.googleapis.com`.
 */
import { readFileSync } from 'node:fs';
import { normalizeHostname } from './google-endpoints.js';

/** One refused destination and what asks for a token there. */
export interface TokenSource {
  /** The host, in `normalizeHostname`'s spelling. */
  readonly host: string;
  /** Human-readable name, used verbatim in the guard's line and error. */
  readonly service: string;
}

const METADATA_SERVER = 'GCE metadata server';

/** The hosts refused whole, wherever the request goes on them. */
export const GOOGLE_TOKEN_HOSTS: readonly TokenSource[] = [
  // Service-account JWT exchange, refresh of a gcloud `authorized_user`
  // credential, tokeninfo and revoke.
  { host: 'oauth2.googleapis.com', service: 'Google OAuth 2.0 token endpoint' },
  // Workload identity federation and downscoped tokens.
  { host: 'sts.googleapis.com', service: 'Google Security Token Service' },
  // Impersonation and `signBlob`, which firebase-admin uses to sign custom
  // tokens without a private key.
  { host: 'iamcredentials.googleapis.com', service: 'IAM Service Account Credentials' },
  // The metadata server. `normalizeHostname` writes every IPv4 form the
  // resolver accepts as the dotted quad, and every IPv6 form compressed, so
  // each spelling meets one of these entries. `metadata` is the short name a
  // GCE resolver completes, and `fd20:ce::254` the IPv6 address Compute
  // Engine documents.
  { host: '169.254.169.254', service: METADATA_SERVER },
  { host: 'metadata.google.internal', service: METADATA_SERVER },
  { host: 'metadata', service: METADATA_SERVER },
  { host: 'fd20:ce::254', service: METADATA_SERVER },
];

/**
 * The host where only token paths are refused (ruling 6). Many unrelated
 * Google APIs live here, and gtoken 7.1.0, which google-auth-library 9 and so
 * firebase-admin's Firestore and Storage load, exchanges at
 * `/oauth2/v4/token`.
 */
export const GOOGLE_TOKEN_PATH_HOST = 'www.googleapis.com';

const GOOGLE_TOKEN_PATH_SERVICE = 'Google OAuth 2.0 token endpoint';

/** `/oauth2/<version>/token`, in {@link comparablePath}'s spelling. */
const OAUTH2_TOKEN_PATH = /^\/oauth2\/[^/]+\/token(?:\/|$)/;

/** The universe-domain hosts google-auth-library builds a token URL on. */
const UNIVERSE_TOKEN_HOSTS: readonly TokenSource[] = [
  { host: 'sts', service: 'Google Security Token Service' },
  { host: 'iamcredentials', service: 'IAM Service Account Credentials' },
];

/** The credentials file fields that name a token URL. */
const CREDENTIAL_URL_FIELDS = ['token_url', 'token_uri', 'service_account_impersonation_url'] as const;

/** A path on a path-scoped host that is refused: the exact path, or a path under it. */
interface PathRule {
  readonly prefix: string;
  readonly service: string;
}

/** The token sources for one process: the fixed list, and what its environment adds. */
export interface TokenEndpoints {
  /** Hosts refused whole, `normalizeHostname`'s spelling to service. */
  readonly hosts: ReadonlyMap<string, string>;
  /** Hosts where only some paths are refused, beside the `/oauth2/<version>/token` rule. */
  readonly paths: ReadonlyMap<string, readonly PathRule[]>;
}

/** What {@link tokenEndpointsFrom} reads. Defaults to the real file system. */
export interface TokenEndpointInput {
  readonly env: Record<string, string | undefined>;
  readonly readFile?: (path: string) => string;
}

/**
 * The token sources for a process with `env`: the fixed list, the hosts in
 * `GCE_METADATA_HOST` and `GCE_METADATA_IP`, and the hosts the credentials
 * file in `GOOGLE_APPLICATION_CREDENTIALS` names. Read once, when the guard
 * installs.
 *
 * A loopback host from the environment or the file is not added. The sandbox
 * itself runs on loopback, so refusing it would refuse the sandbox, and a
 * metadata stand-in on this machine holds no Google credential.
 */
export function tokenEndpointsFrom(input: TokenEndpointInput): TokenEndpoints {
  const hosts = new Map<string, string>();
  const paths = new Map<string, PathRule[]>();
  for (const source of GOOGLE_TOKEN_HOSTS) hosts.set(source.host, source.service);
  for (const name of ['GCE_METADATA_HOST', 'GCE_METADATA_IP'] as const) {
    const host = hostOfSetting(input.env[name]);
    if (host !== undefined) addHost(hosts, host, `${METADATA_SERVER} named by ${name}`);
  }
  const file = input.env.GOOGLE_APPLICATION_CREDENTIALS;
  const hasFile = file !== undefined && file.trim().length > 0;
  if (hasFile) addCredentialFileSources({ hosts, paths }, readCredentials(file, input.readFile));
  return { hosts, paths };
}

/**
 * The token source a request to `host`, with `path` when the seam knows it,
 * reaches, or `undefined`. `host` must already be in `normalizeHostname`'s
 * spelling.
 */
export function findTokenSource(
  endpoints: TokenEndpoints,
  host: string,
  path?: string,
): TokenSource | undefined {
  const service = endpoints.hosts.get(host);
  if (service !== undefined) return { host, service };
  if (path === undefined) return undefined;
  const comparable = comparablePath(path);
  const isTokenPath = host === GOOGLE_TOKEN_PATH_HOST && OAUTH2_TOKEN_PATH.test(comparable);
  if (isTokenPath) return { host, service: GOOGLE_TOKEN_PATH_SERVICE };
  const rule = endpoints.paths.get(host)?.find((candidate) => isUnder(comparable, candidate.prefix));
  if (rule !== undefined) return { host, service: rule.service };
  return undefined;
}

/**
 * A request path in one spelling: no query or fragment, percent-escapes
 * decoded, repeated slashes collapsed, lowercased. A server may read
 * `//OAuth2/v4/%74oken` as the token path, so the comparison does too.
 */
export function comparablePath(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? '';
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // A malformed escape: compare the text as written.
  }
  const collapsed = decoded.replace(/\/{2,}/g, '/').toLowerCase();
  if (collapsed.startsWith('/')) return collapsed;
  return `/${collapsed}`;
}

function isUnder(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(base);
}

const LOOPBACK_NAMES: readonly string[] = ['localhost', '::1'];

function isLoopback(host: string): boolean {
  const isLoopbackName = LOOPBACK_NAMES.includes(host) || host.endsWith('.localhost');
  return isLoopbackName || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function addHost(hosts: Map<string, string>, host: string, service: string): void {
  const isNew = !hosts.has(host);
  if (isNew && !isLoopback(host)) hosts.set(host, service);
}

/** `name`, `name:port`, `[v6]:port`, `v6` or a URL, as `GCE_METADATA_HOST` may hold, to a host. */
function hostOfSetting(value: string | undefined): string | undefined {
  const text = (value ?? '').trim();
  if (text.length === 0) return undefined;
  const withScheme = text.includes('://') ? text : `http://${text}`;
  const parsed = urlHost(withScheme);
  if (parsed !== undefined) return parsed;
  // A bare IPv6 address has colons the URL parser reads as a port.
  return normalizeHostname(text);
}

/** The host of `url` in `normalizeHostname`'s spelling, or `undefined`. */
function urlHost(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.length === 0) return undefined;
    return normalizeHostname(hostname);
  } catch {
    return undefined;
  }
}

type CredentialJson = Record<string, unknown>;

function readCredentials(path: string, readFile?: (path: string) => string): CredentialJson | undefined {
  const read = readFile ?? ((file: string) => readFileSync(file, 'utf8'));
  try {
    const parsed: unknown = JSON.parse(read(path));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    // No file, or not JSON: google-auth-library fails on it too.
    return undefined;
  }
}

function isObject(value: unknown): value is CredentialJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the credentials file adds: its token URLs, and `sts.` and `iamcredentials.` under its universe. */
function addCredentialFileSources(
  target: { hosts: Map<string, string>; paths: Map<string, PathRule[]> },
  json: CredentialJson | undefined,
): void {
  if (json === undefined) return;
  const service = 'token endpoint named by GOOGLE_APPLICATION_CREDENTIALS';
  for (const field of CREDENTIAL_URL_FIELDS) addCredentialUrl(target, json[field], service);
  const universe = json.universe_domain;
  if (typeof universe === 'string' && universe.trim().length > 0) {
    for (const source of UNIVERSE_TOKEN_HOSTS) {
      const host = urlHost(`https://${source.host}.${universe.trim()}/`);
      if (host !== undefined) addHost(target.hosts, host, source.service);
    }
  }
  // An `impersonated_service_account` file carries the credential it starts from.
  if (isObject(json.source_credentials)) addCredentialFileSources(target, json.source_credentials);
}

function addCredentialUrl(
  target: { hosts: Map<string, string>; paths: Map<string, PathRule[]> },
  value: unknown,
  service: string,
): void {
  if (typeof value !== 'string') return;
  const host = urlHost(value);
  if (host === undefined) return;
  // On the path-scoped host, refuse the path the file names, not the whole host.
  if (host === GOOGLE_TOKEN_PATH_HOST) {
    const rules = target.paths.get(host) ?? [];
    rules.push({ prefix: comparablePath(new URL(value).pathname), service });
    target.paths.set(host, rules);
    return;
  }
  addHost(target.hosts, host, service);
}
