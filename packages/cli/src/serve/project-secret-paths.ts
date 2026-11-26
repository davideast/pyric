/**
 * Project paths pyric's dev routes never serve.
 *
 * `.pyric/` holds project state (users, documents, session files); `.git/`
 * holds repository control files and executable hooks; `.ssh/` and `.aws/`
 * hold user credentials; env, package-registry, private-key, and service-
 * account files hold secrets; and `node_modules` is installed code nobody
 * edits through Studio. The workspace routes refuse all of these. Vite serves
 * dependencies from `node_modules`, so its real-path guard refuses only the
 * secret/control set.
 *
 * Every check takes a project-relative path and looks at each segment, so a
 * nested `web/.pyric/` or `functions/.env` counts too. Names compare without
 * case, and a trailing period or space is dropped first, because a
 * case-insensitive disk (macOS, Windows) opens `.PYRIC` as `.pyric` and
 * Windows opens `.env.` as `.env`.
 */

const SECRET_DIRECTORIES: ReadonlySet<string> = new Set([
  '.pyric',
  '.git',
  '.ssh',
  '.aws',
]);

const SECRET_EXACT_FILES: ReadonlySet<string> = new Set([
  '.env',
  '.envrc',
  '.npmrc',
  '.yarnrc',
  '.netrc',
  '.pypirc',
  'application_default_credentials.json',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
]);

const SECRET_FILE_PREFIXES: readonly string[] = [
  '.env.',
  '.npmrc.',
  '.yarnrc',
];

const PRIVATE_KEY_EXTENSIONS: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
];

const DEPENDENCY_DIRECTORY = 'node_modules';

/** A segment as the disk may open it: lower case, without a trailing period or space. */
function diskName(segment: string): string {
  return segment.replace(/[. ]+$/, '').toLowerCase();
}

function isPrivateKeyFilename(name: string): boolean {
  return PRIVATE_KEY_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function isCredentialJsonFilename(name: string): boolean {
  if (!name.endsWith('.json')) {
    return false;
  }
  return (
    name.includes('service-account') ||
    name.includes('service_account') ||
    name.includes('serviceaccount') ||
    name.includes('firebase-adminsdk')
  );
}

function isSecretOrControlSegment(segment: string): boolean {
  const name = diskName(segment);
  if (name.length === 0) {
    return false;
  }
  if (SECRET_DIRECTORIES.has(name)) {
    return true;
  }
  if (SECRET_EXACT_FILES.has(name)) {
    return true;
  }
  if (SECRET_FILE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return true;
  }
  if (isPrivateKeyFilename(name)) {
    return true;
  }
  return isCredentialJsonFilename(name);
}

function isDependencySegment(segment: string): boolean {
  return diskName(segment) === DEPENDENCY_DIRECTORY;
}

function segmentsOf(relativePath: string): string[] {
  return relativePath.split(/[/\\]/).filter((segment) => segment !== '' && segment !== '.');
}

/**
 * True when a path touches `.pyric/`, repository/auth control directories
 * (`.git`, `.ssh`, `.aws`), env/registry config (`.env*`, `.envrc`, `.npmrc`,
 * `.yarnrc*`), or private-key/service-account credential files. Both planes
 * share this set; Vite still serves `node_modules`.
 */
export function isPyricStateOrEnvPath(relativePath: string): boolean {
  return segmentsOf(relativePath).some(isSecretOrControlSegment);
}

/** True when a project-relative path is one the workspace routes never serve. */
export function isProjectSecretPath(relativePath: string): boolean {
  const segments = segmentsOf(relativePath);
  return segments.some(isSecretOrControlSegment) || segments.some(isDependencySegment);
}
