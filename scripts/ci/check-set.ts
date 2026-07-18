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
  if (everyPathMatches(input.paths, (path) => AUTHORED_DOC_MARKDOWN.test(path))) return 'docs-only';
  return 'full';
}
