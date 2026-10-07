/**
 * Realtime Database instance identity.
 *
 * Production identifies an RTDB instance by its name: the namespace the SDK
 * parses out of a database URL, and the `instance` value of a `database` entry
 * in `firebase.json`. Every sandbox and served-host structure that holds one
 * value per instance keys it by this name.
 *
 * {@link parseDatabaseUrl} is a port of the JS SDK's `parseRepoInfo`,
 * `validateUrl` and root-path check from `@firebase/database`, so the same URL
 * yields the same instance name and a malformed URL throws the same `Error`
 * with the same message.
 */

/** One RTDB instance: its name and the root URL production reports for it. */
export interface DatabaseInstance {
  /** The instance name (the SDK's namespace). */
  readonly name: string;
  /**
   * The root URL the SDK reports for the instance (`RepoInfo.toURLString()`):
   * lowercase host with any regional domain and port kept, a trailing slash,
   * and `?ns=<name>` when the name is not the host's first label.
   */
  readonly url: string;
}

/**
 * Registry key of the default instance when no project id names it. The
 * parentheses keep it apart from every valid instance name.
 */
export const UNNAMED_DEFAULT_DATABASE_INSTANCE = '(default)';

/** The default instance name production derives from a project id. */
export function defaultDatabaseInstanceName(projectId: string): string {
  return `${projectId}-default-rtdb`;
}

/** The instance the SDK uses for an app with a project id and no `databaseURL`. */
export function defaultDatabaseInstance(projectId: string): DatabaseInstance {
  return parseDatabaseUrl(`${defaultDatabaseInstanceName(projectId)}.firebaseio.com`);
}

/**
 * The instance a database URL names, as the production SDK parses it.
 * Throws the SDK's error for a URL `getDatabase` rejects.
 */
export function parseDatabaseUrl(databaseUrl: string): DatabaseInstance {
  const parsed = parseUrlParts(databaseUrl);
  if (parsed.domain === 'firebase.com') {
    throw fatal(`${parsed.host} is no longer supported. Please use <YOUR FIREBASE>.firebaseio.com instead`);
  }
  const namespace = parsed.namespace;
  if ((!namespace || namespace === 'undefined') && parsed.domain !== 'localhost') {
    throw fatal('Cannot parse Firebase url. Please use https://<YOUR FIREBASE>.firebaseio.com');
  }
  const host = parsed.host.toLowerCase();
  const rootPath = parsed.pathSegments.length === 0 ? '/' : `/${parsed.pathSegments.join('/')}`;
  if (
    host.length === 0
    || (!isValidKey(namespace) && host.split(':')[0] !== 'localhost')
    || !isValidRootPathString(rootPath)
  ) {
    throw new Error(
      'Invalid Firebase Database URL failed: url argument must be a valid firebase URL and the path can\'t contain ".", "#", "$", "[", or "]".',
    );
  }
  if (parsed.pathSegments.length > 0) {
    throw fatal('Database URL must point to the root of a Firebase Database (not including a child path).');
  }
  const query = namespace !== parsed.subdomain ? `?ns=${namespace}` : '';
  return { name: namespace, url: `${parsed.secure ? 'https://' : 'http://'}${host}/${query}` };
}

/**
 * The instance a `firebase.json` `database` entry names with `instance`.
 * Names are lowercased as the SDK lowercases a URL's first host label.
 */
export function databaseInstanceNamed(name: string): DatabaseInstance {
  if (!INSTANCE_NAME.test(name)) {
    throw fatal('Cannot parse Firebase url. Please use https://<YOUR FIREBASE>.firebaseio.com');
  }
  return parseDatabaseUrl(`${name}.firebaseio.com`);
}

/**
 * The instance a sandbox `getDatabase(sandbox, url)` argument selects.
 * `undefined` selects the default instance: no argument, an empty string, or
 * the keyword `default`. A bare name selects that instance by name; any other
 * value is parsed as a database URL with {@link parseDatabaseUrl}.
 */
export function resolveDatabaseInstance(urlOrName?: string): DatabaseInstance | undefined {
  if (urlOrName === undefined) return undefined;
  const trimmed = urlOrName.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'default') return undefined;
  if (/^[^./:?#]+$/.test(trimmed)) return databaseInstanceNamed(trimmed);
  return parseDatabaseUrl(urlOrName);
}

/**
 * The key a per-instance structure stores an instance under: its name, with
 * the default instance under `defaultName` when the project id is known and
 * {@link UNNAMED_DEFAULT_DATABASE_INSTANCE} otherwise.
 */
export function databaseInstanceKey(instance: DatabaseInstance | undefined, defaultName?: string): string {
  if (instance === undefined) return defaultName ?? UNNAMED_DEFAULT_DATABASE_INSTANCE;
  return instance.name;
}

/** One value per RTDB instance, created on first use and enumerable. */
export interface DatabaseInstanceRegistry<T> {
  /** Key of the default instance. */
  readonly defaultKey: string;
  /** The key `instance` is stored under; `undefined` is the default instance. */
  keyOf(instance: DatabaseInstance | undefined): string;
  /** The value for `key`, created with the registry's `create` on first use. */
  getOrCreate(key: string): T;
  get(key: string): T | undefined;
  /** Every created value with its key, in creation order. */
  entries(): IterableIterator<[string, T]>;
}

export function createDatabaseInstanceRegistry<T>(options: {
  create: (key: string) => T;
  /** The project's default instance name, when the project id is known. */
  defaultName?: string;
}): DatabaseInstanceRegistry<T> {
  const values = new Map<string, T>();
  const defaultKey = databaseInstanceKey(undefined, options.defaultName);
  return {
    defaultKey,
    keyOf: (instance) => databaseInstanceKey(instance, options.defaultName),
    getOrCreate(key) {
      let value = values.get(key);
      if (value === undefined) {
        value = options.create(key);
        values.set(key, value);
      }
      return value;
    },
    get: (key) => values.get(key),
    entries: () => values.entries(),
  };
}

// Port of `parseDatabaseURL` from `@firebase/database`. It does no validation;
// `parseDatabaseUrl` validates the parts as `parseRepoInfo` and `validateUrl` do.
function parseUrlParts(dataUrl: string): {
  host: string;
  domain: string;
  subdomain: string;
  secure: boolean;
  pathSegments: string[];
  namespace: string;
} {
  let rest = dataUrl;
  let host = '';
  let domain = '';
  let subdomain = '';
  let namespace = '';
  let pathSegments: string[] = [];
  let secure = true;
  let scheme = 'https';

  let colonIndex = rest.indexOf('//');
  if (colonIndex >= 0) {
    scheme = rest.substring(0, colonIndex - 1);
    rest = rest.substring(colonIndex + 2);
  }
  let slashIndex = rest.indexOf('/');
  if (slashIndex === -1) slashIndex = rest.length;
  let questionIndex = rest.indexOf('?');
  if (questionIndex === -1) questionIndex = rest.length;
  host = rest.substring(0, Math.min(slashIndex, questionIndex));
  if (slashIndex < questionIndex) {
    pathSegments = decodePath(rest.substring(slashIndex, questionIndex));
  }
  const queryParams = decodeQuery(rest.substring(Math.min(rest.length, questionIndex)));

  colonIndex = host.indexOf(':');
  if (colonIndex >= 0) {
    secure = scheme === 'https' || scheme === 'wss';
  } else {
    colonIndex = host.length;
  }
  const hostWithoutPort = host.slice(0, colonIndex);
  if (hostWithoutPort.toLowerCase() === 'localhost') {
    domain = 'localhost';
  } else if (hostWithoutPort.split('.').length <= 2) {
    domain = hostWithoutPort;
  } else {
    const dotIndex = host.indexOf('.');
    subdomain = host.substring(0, dotIndex).toLowerCase();
    domain = host.substring(dotIndex + 1);
    namespace = subdomain;
  }
  if (Object.prototype.hasOwnProperty.call(queryParams, 'ns')) {
    namespace = queryParams.ns!;
  }
  return { host, domain, subdomain, secure, pathSegments, namespace };
}

function decodePath(pathString: string): string[] {
  const segments: string[] = [];
  for (const piece of pathString.split('/')) {
    if (piece.length === 0) continue;
    let decoded = piece;
    try {
      decoded = decodeURIComponent(piece.replace(/\+/g, ' '));
    } catch {
      // The SDK keeps a segment it cannot decode as written.
    }
    segments.push(decoded);
  }
  return segments;
}

function decodeQuery(queryString: string): Record<string, string> {
  const results: Record<string, string> = {};
  if (queryString.charAt(0) === '?') queryString = queryString.substring(1);
  for (const segment of queryString.split('&')) {
    if (segment.length === 0) continue;
    const pair = segment.split('=');
    if (pair.length === 2) results[decodeURIComponent(pair[0]!)] = decodeURIComponent(pair[1]!);
  }
  return results;
}

const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const INVALID_KEY = /[[\].#$/\u0000-\u001F\u007F]/;
const INVALID_PATH = /[[\].#$\u0000-\u001F\u007F]/;

function isValidKey(key: string): boolean {
  return key.length !== 0 && !INVALID_KEY.test(key);
}

function isValidRootPathString(pathString: string): boolean {
  const withoutInfo = pathString.replace(/^\/*\.info(\/|$)/, '/');
  return withoutInfo.length !== 0 && !INVALID_PATH.test(withoutInfo);
}

function fatal(message: string): Error {
  return new Error(`FIREBASE FATAL ERROR: ${message} `);
}
