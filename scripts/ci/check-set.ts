export type PrCheckSet = 'full' | 'release-only' | 'docs-only';

export interface ChangedPath {
  path: string;
  /** Present for a rename. Both sides must qualify for the same fast path. */
  previousPath?: string;
}

export interface CheckSetInput {
  event: 'pull_request' | 'push' | 'schedule' | 'workflow_dispatch';
  labels: readonly string[];
  paths: readonly ChangedPath[];
}

const RELEASE_WRAPPERS = new Set([
  'scripts/publish-alpha.sh',
]);
const AUTHORED_DOC_MARKDOWN = /^packages\/site-docs\/src\/content\/.+\.md$/;
const INTERNAL_REPO_DOCS = new Set([
  'PRIORITIES.md',
  'CONTEXT.md',
  'AGENTS.md',
  '.github/pull_request_template.md',
]);

function isDocMarkdown(path: string): boolean {
  return AUTHORED_DOC_MARKDOWN.test(path) || INTERNAL_REPO_DOCS.has(path);
}

/** Changes that invalidate what the packaging gate proves: the scaffolder's
 *  own output, a published package's manifest (its name, exports, or files),
 *  and the packaging scripts themselves. The workflow comment already named
 *  these as the moment to apply the `ci-packaging` label; deciding it from the
 *  diff removes the dependency on the author remembering. */
const PACKAGING_SCRIPTS = new Set([
  'scripts/packaging-test.sh',
  'scripts/install-matrix.sh',
  'scripts/lib/package-artifact-manifest.ts',
]);
const SCAFFOLDER_SOURCE = /^packages\/create-pyric\//;
const PUBLISHED_MANIFEST = /^packages\/[^/]+\/package\.json$/;

export function requiresPackagingProof(paths: readonly ChangedPath[]): boolean {
  const touches = (path: string): boolean =>
    PACKAGING_SCRIPTS.has(path) || SCAFFOLDER_SOURCE.test(path) || PUBLISHED_MANIFEST.test(path);
  return paths.some(({ path, previousPath }) =>
    touches(path) || (previousPath !== undefined && touches(previousPath))
  );
}

function everyPathMatches(
  paths: readonly ChangedPath[],
  predicate: (path: string) => boolean,
): boolean {
  return paths.length > 0 && paths.every(({ path, previousPath }) =>
    predicate(path) && (previousPath === undefined || predicate(previousPath))
  );
}

/** Selects one of two deliberately tiny fast paths. Everything else fails
 * closed to the full suite; this is not a codebase dependency classifier. */
export function selectPrCheckSet(input: CheckSetInput): PrCheckSet {
  if (input.event !== 'pull_request' || input.labels.some((label) => label === 'ci-full' || label === 'ci-packaging')) {
    return 'full';
  }
  if (everyPathMatches(input.paths, (path) => RELEASE_WRAPPERS.has(path))) return 'release-only';
  if (everyPathMatches(input.paths, isDocMarkdown)) return 'docs-only';
  return 'full';
}
