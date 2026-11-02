/**
 * Project paths pyric's dev routes never serve.
 *
 * `.pyric/` holds project state (users, documents, session files), `.env*`
 * files hold credentials, and `node_modules` is installed code nobody edits
 * through Studio. The workspace routes refuse all three. Vite serves
 * dependencies from `node_modules`, so its real-path guard refuses only the
 * first two.
 *
 * Every check takes a project-relative path and looks at each segment, so a
 * nested `web/.pyric/` or `functions/.env` counts too. Names compare without
 * case, and a trailing period or space is dropped first, because a
 * case-insensitive disk (macOS, Windows) opens `.PYRIC` as `.pyric` and
 * Windows opens `.env.` as `.env`.
 */

const PYRIC_DIRECTORY = '.pyric';
/** The literal pattern `.env*`: `.env`, `.env.local`, `.envrc`. */
const ENV_PREFIX = '.env';
const DEPENDENCY_DIRECTORY = 'node_modules';

/** A segment as the disk may open it: lower case, without a trailing period or space. */
function diskName(segment: string): string {
  return segment.replace(/[. ]+$/, '').toLowerCase();
}

function isPyricOrEnvSegment(segment: string): boolean {
  const name = diskName(segment);
  return name === PYRIC_DIRECTORY || name.startsWith(ENV_PREFIX);
}

function isDependencySegment(segment: string): boolean {
  return diskName(segment) === DEPENDENCY_DIRECTORY;
}

function segmentsOf(relativePath: string): string[] {
  return relativePath.split(/[/\\]/).filter((segment) => segment !== '' && segment !== '.');
}

/** True when a path is in `.pyric/` or passes through a `.env*` name. Both planes share this set. */
export function isPyricStateOrEnvPath(relativePath: string): boolean {
  return segmentsOf(relativePath).some(isPyricOrEnvSegment);
}

/** True when a project-relative path is one the workspace routes never serve. */
export function isProjectSecretPath(relativePath: string): boolean {
  const segments = segmentsOf(relativePath);
  return segments.some(isPyricOrEnvSegment) || segments.some(isDependencySegment);
}
