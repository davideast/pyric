export type PrCheckSet = 'full' | 'release-only' | 'docs-only';

export interface ChangedPath {
  path: string;
  /** Present for a rename. Both sides must qualify for the same fast path. */
  previousPath?: string;
}

export interface CheckSetInput {
  /** `merge_group` is a merge queue run: a group of pull requests tested
   *  together on a gh-readonly-queue branch before they merge. */
  event: 'pull_request' | 'merge_group' | 'push' | 'schedule' | 'workflow_dispatch';
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

const FULL_PROOF_LABELS = new Set(['ci-full', 'ci-packaging']);

function mayTakeFastPath(input: CheckSetInput): boolean {
  const asksForFullProof = input.labels.some((label) => FULL_PROOF_LABELS.has(label));
  return input.event === 'pull_request' && !asksForFullProof;
}

/** Selects one of two deliberately tiny fast paths. Everything else fails
 * closed to the full suite; this is not a codebase dependency classifier. */
export function selectPrCheckSet(input: CheckSetInput): PrCheckSet {
  if (!mayTakeFastPath(input)) return 'full';
  if (everyPathMatches(input.paths, (path) => RELEASE_WRAPPERS.has(path))) return 'release-only';
  if (everyPathMatches(input.paths, isDocMarkdown)) return 'docs-only';
  return 'full';
}

/** A check set the planner computes and records but does not run yet. */
export type ShadowCheckSet = 'rules-only' | 'none';

/** The rules package and the conformance data only the rules scorecards and
 *  replay gates read: the language snapshots and acceptance evidence, the
 *  rules corpus, the committed rules observations, the Storage rules
 *  exceptions and the scorecard baselines. Code under packages/conformance/src
 *  and the assurance node counts stay out, so they fail closed. */
const RULES_ONLY_PATHS = [
  /^packages\/rules\//,
  /^packages\/conformance\/rules-language\//,
  /^packages\/conformance\/rules-corpus\//,
  /^packages\/conformance\/observations\/(firestore|storage|rtdb)-rules\//,
  /^packages\/conformance\/storage-rules-exceptions\//,
  /^packages\/conformance\/baselines\/(firestore|storage|rtdb)-rules-scorecard\.json$/,
];

function isRulesOnlyPath(path: string): boolean {
  return RULES_ONLY_PATHS.some((pattern) => pattern.test(path));
}

/** What `rules-only` would run once enforced: the rules package tests, the
 *  rules scorecards (compat:rules-score also runs the Firestore rules oracle
 *  replay) and the replay gates. Recorded beside the selection. */
export const RULES_ONLY_PROOF: readonly string[] = [
  'bun test --cwd packages/rules',
  'bun run compat:rules-score',
  'bun test packages/conformance/test/src/rules-scorecard-gate.test.ts packages/conformance/test/src/firestore-rules-scorecard-gate.test.ts packages/conformance/test/src/storage-rules-scorecard-gate.test.ts packages/conformance/test/src/rtdb-rules-scorecard-gate.test.ts',
  'bun test packages/conformance/test/src/firestore-rules-oracle-replay.test.ts packages/conformance/test/src/storage-stdlib-real-replay.test.ts',
];

/** The shadow selection (#1521 E1). It never changes what selectPrCheckSet
 *  gates; plan.ts records it beside the set that runs. */
export function selectShadowCheckSet(input: CheckSetInput): ShadowCheckSet {
  if (!mayTakeFastPath(input)) return 'none';
  return everyPathMatches(input.paths, isRulesOnlyPath) ? 'rules-only' : 'none';
}
