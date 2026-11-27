/**
 * Loads `.env`, `.env.<project>`, `.env.local`, and `.secret.local` from a
 * Functions source directory in Firebase's documented precedence order while
 * preserving sandbox project and Google credential isolation (#1939, #1463, #3203).
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Host credential, ADC lookup, and Firebase debug variables that neither the
 * host environment nor user `.env` files may inject into the Functions child.
 */
export const STRIPPED_FUNCTIONS_ENV_KEYS: ReadonlySet<string> = new Set([
  'google_application_credentials',
  'firebase_sa_base64',
  'google_cloud_quota_project',
  'gcloud_project',
  'google_cloud_project',
  'gcp_project',
  'cloudsdk_config',
  'home',
  'appdata',
  'userprofile',
  'firebase_debug_mode',
  'firebase_debug_features',
]);

/**
 * System runtime keys reserved by Cloud Functions (`firebase-tools` `env.ts`)
 * and Node loader variables that `.env` files must never override.
 */
const RESERVED_FUNCTIONS_ENV_KEYS: ReadonlySet<string> = new Set([
  'firebase_config',
  'cloud_runtime_config',
  'entry_point',
  'function_name',
  'function_target',
  'function_signature_type',
  'k_service',
  'k_revision',
  'k_configuration',
  'port',
  'node_options',
  'node_path',
  'node_extra_ca_certs',
]);

const PROJECT_ROOT_MARKERS = ['firebase.json', '.firebaserc', '.git'] as const;

const DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\[\s\S]|[^'\\])*'|\s*"(?:\\[\s\S]|[^"\\])*"|\s*`(?:\\[\s\S]|[^`\\])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/**
 * Whether an environment variable name is reserved by Cloud Functions, Node
 * module preloading, or Pyric sandbox credential isolation.
 */
export function isProtectedFunctionsEnvKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (STRIPPED_FUNCTIONS_ENV_KEYS.has(lower)) {
    return true;
  }
  if (RESERVED_FUNCTIONS_ENV_KEYS.has(lower)) {
    return true;
  }
  if (lower.startsWith('pyric_') || lower.startsWith('x_google_')) {
    return true;
  }
  return false;
}

/**
 * Parse dotenv file contents into key-value pairs following `dotenv.parse`
 * semantics (comments, `export`, single/double/backtick quotes, multiline
 * quoted strings, `\n` and `\r` escapes in double-quoted strings, and CRLF).
 */
export function parseDotenv(source: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  let normalized = source;
  if (normalized.startsWith('\uFEFF')) {
    normalized = normalized.slice(1);
  }
  normalized = normalized.replace(/\r\n?/g, '\n');

  DOTENV_LINE.lastIndex = 0;
  for (;;) {
    const match = DOTENV_LINE.exec(normalized);
    if (match === null) {
      break;
    }
    const key = match[1];
    if (key === undefined) {
      continue;
    }
    const rawValue = (match[2] ?? '').trim();
    const quote = rawValue[0];
    const hasMatchingQuote =
      rawValue.length >= 2 &&
      (quote === '"' || quote === "'" || quote === '`') &&
      rawValue.endsWith(quote);

    let value = rawValue;
    if (hasMatchingQuote && quote !== undefined) {
      value = rawValue.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\([nr"\\])/g, (_full, escaped: string) => {
          if (escaped === 'n') return '\n';
          if (escaped === 'r') return '\r';
          if (escaped === '"') return '"';
          return '\\';
        });
      } else if (quote === "'") {
        value = value.replace(/\\'/g, "'");
      } else if (quote === '`') {
        value = value.replace(/\\`/g, '`');
      }
    }
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Infer the Functions source directory when only the resolved `entry` file path
 * is supplied (for example `functions/lib/index.js` -> `functions/`).
 */
export function resolveFunctionsSourceDir(entry: string, explicitSourceDir?: string): string {
  if (typeof explicitSourceDir === 'string' && explicitSourceDir.length > 0) {
    return resolve(explicitSourceDir);
  }
  const entryDir = dirname(resolve(entry));
  let current = entryDir;
  for (;;) {
    if (existsSync(join(current, 'package.json'))) {
      return current;
    }
    const reachedProjectRoot = PROJECT_ROOT_MARKERS.some((marker) =>
      existsSync(join(current, marker)),
    );
    if (reachedProjectRoot) {
      return entryDir;
    }
    const parent = dirname(current);
    if (parent === current) {
      return entryDir;
    }
    current = parent;
  }
}

function findProjectAliasesForId(sourceDir: string, projectId: string): string[] {
  const candidates = [dirname(sourceDir), sourceDir];
  for (const dir of candidates) {
    const rcPath = join(dir, '.firebaserc');
    if (!existsSync(rcPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(rcPath, 'utf8')) as {
        projects?: Record<string, unknown>;
      };
      const projects = parsed.projects;
      if (typeof projects !== 'object' || projects === null) {
        continue;
      }
      const aliases: string[] = [];
      for (const [alias, target] of Object.entries(projects)) {
        if (target === projectId && alias !== projectId && alias !== 'default') {
          aliases.push(alias);
        }
      }
      return aliases;
    } catch {
      // Ignore malformed `.firebaserc` during optional alias fallback lookup.
    }
  }
  return [];
}

function readContainedDotenvFile(realSourceDir: string, filename: string): string | null {
  if (filename.includes('/') || filename.includes('\\') || filename === '..') {
    return null;
  }
  const candidate = join(realSourceDir, filename);
  if (!existsSync(candidate)) {
    return null;
  }
  try {
    const linkStats = lstatSync(candidate);
    const realCandidate = realpathSync(candidate);
    const insideSourceDir = realCandidate.startsWith(`${realSourceDir}${sep}`);
    if (!insideSourceDir) {
      return null;
    }
    const targetStats = linkStats.isSymbolicLink() ? statSync(realCandidate) : linkStats;
    if (!targetStats.isFile()) {
      return null;
    }
    return readFileSync(realCandidate, 'utf8');
  } catch {
    // Unreadable or disappearing dotenv files are skipped without crashing startup.
    return null;
  }
}

export interface LoadFunctionsDotenvOptions {
  sourceDir: string;
  projectId: string;
  projectAlias?: string;
  /** Whether to merge `.secret.local` with highest precedence (default: true). */
  includeSecrets?: boolean;
}

export interface FunctionsEnvAndSecrets {
  /** Merged user env and local secrets (`.env` < `.env.<project>` < `.env.local` < `.secret.local`). */
  env: Record<string, string>;
  /** Entries loaded specifically from `.secret.local` (never containing protected keys). */
  secrets: Record<string, string>;
}

const SECRET_LOCAL_FILENAME = '.secret.local';

function resolveRealSourceDir(sourceDir: string): string | null {
  const resolvedDir = resolve(sourceDir);
  if (!existsSync(resolvedDir)) {
    return null;
  }
  try {
    const dirStats = statSync(resolvedDir);
    if (!dirStats.isDirectory()) {
      return null;
    }
    return realpathSync(resolvedDir);
  } catch {
    // Non-existent or inaccessible source directory yields no dotenv entries.
    return null;
  }
}

function mergeDotenvEntries(
  target: Record<string, string>,
  content: string,
): void {
  const entries = parseDotenv(content);
  for (const [key, value] of Object.entries(entries)) {
    if (isProtectedFunctionsEnvKey(key)) {
      continue;
    }
    target[key] = value;
  }
}

/**
 * Load only `.secret.local` entries from `sourceDir`, preserving symlink
 * containment and refusing protected credential/runtime keys.
 */
export function loadFunctionsSecrets(
  options: Pick<LoadFunctionsDotenvOptions, 'sourceDir'>,
): Record<string, string> {
  const realSourceDir = resolveRealSourceDir(options.sourceDir);
  if (realSourceDir === null) {
    return {};
  }
  const secretContent = readContainedDotenvFile(realSourceDir, SECRET_LOCAL_FILENAME);
  if (secretContent === null) {
    return {};
  }
  const secrets: Record<string, string> = {};
  mergeDotenvEntries(secrets, secretContent);
  return secrets;
}

/**
 * Load user dotenv entries and `.secret.local` in Firebase's documented local
 * emulator precedence order:
 * `.env` < `.env.<project>` < `.env.local` < `.secret.local`.
 */
export function loadFunctionsEnvAndSecrets(
  options: LoadFunctionsDotenvOptions,
): FunctionsEnvAndSecrets {
  const realSourceDir = resolveRealSourceDir(options.sourceDir);
  if (realSourceDir === null) {
    return { env: {}, secrets: {} };
  }

  const orderedContents: string[] = [];
  const baseContent = readContainedDotenvFile(realSourceDir, '.env');
  if (baseContent !== null) {
    orderedContents.push(baseContent);
  }

  const projectContent = readContainedDotenvFile(realSourceDir, `.env.${options.projectId}`);
  if (projectContent !== null) {
    orderedContents.push(projectContent);
  } else {
    const aliases: string[] = [];
    if (
      typeof options.projectAlias === 'string' &&
      options.projectAlias.length > 0 &&
      options.projectAlias !== options.projectId
    ) {
      aliases.push(options.projectAlias);
    }
    for (const discovered of findProjectAliasesForId(realSourceDir, options.projectId)) {
      if (!aliases.includes(discovered)) {
        aliases.push(discovered);
      }
    }
    for (const alias of aliases) {
      const aliasContent = readContainedDotenvFile(realSourceDir, `.env.${alias}`);
      if (aliasContent !== null) {
        orderedContents.push(aliasContent);
        break;
      }
    }
  }

  const localContent = readContainedDotenvFile(realSourceDir, '.env.local');
  if (localContent !== null) {
    orderedContents.push(localContent);
  }

  const merged: Record<string, string> = {};
  for (const content of orderedContents) {
    mergeDotenvEntries(merged, content);
  }

  const secrets: Record<string, string> = {};
  if (options.includeSecrets !== false) {
    const secretContent = readContainedDotenvFile(realSourceDir, SECRET_LOCAL_FILENAME);
    if (secretContent !== null) {
      mergeDotenvEntries(secrets, secretContent);
      for (const [key, value] of Object.entries(secrets)) {
        merged[key] = value;
      }
    }
  }

  return { env: merged, secrets };
}

/**
 * Load user dotenv entries in Firebase's documented local emulator precedence order:
 * `.env` < `.env.<project>` < `.env.local` < `.secret.local`.
 */
export function loadFunctionsDotenv(options: LoadFunctionsDotenvOptions): Record<string, string> {
  return loadFunctionsEnvAndSecrets(options).env;
}

/**
 * Apply loaded dotenv and `.secret.local` entries onto `targetEnv`, skipping
 * all protected keys, and return the secret map loaded from `.secret.local`.
 */
export function applyFunctionsDotenv(
  targetEnv: NodeJS.ProcessEnv,
  options: LoadFunctionsDotenvOptions,
): Record<string, string> {
  const { env: loaded, secrets } = loadFunctionsEnvAndSecrets(options);
  for (const [key, value] of Object.entries(loaded)) {
    targetEnv[key] = value;
  }
  return secrets;
}
