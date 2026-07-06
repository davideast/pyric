/** Branches the agent must never push or open PRs from. */
export const PROTECTED_BRANCH_NAMES = new Set([
  'main',
  'master',
  'production',
  'develop',
  'development',
  'release',
  'staging',
]);

const REPO_FULL_NAME = /^[\w.-]+\/[\w.-]+$/;
const REPO_NAME = /^[a-zA-Z0-9._-]{1,100}$/;
const FEATURE_BRANCH =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._/-]{0,100}[a-zA-Z0-9])?$|^[a-zA-Z0-9]$/;

/** GitHub repository name rules (user-owned repos). */
export function validateRepoName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Repository name is required.');
  }
  if (trimmed.includes('..') || trimmed.startsWith('.') || trimmed.endsWith('.')) {
    throw new Error(
      `Invalid repo name "${name}" — cannot start/end with "." or contain "..".`,
    );
  }
  if (!REPO_NAME.test(trimmed)) {
    throw new Error(
      `Invalid repo name "${name}" — use 1–100 letters, digits, ".", "_", or "-".`,
    );
  }
}

export function parseRepoFullName(repo: string): { owner: string; name: string } {
  const trimmed = repo.trim();
  if (!REPO_FULL_NAME.test(trimmed)) {
    throw new Error(
      `Invalid repo "${repo}" — expected owner/name (e.g. acme/firebase-app).`,
    );
  }
  const slash = trimmed.indexOf('/');
  return { owner: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
}

export function validateFeatureBranch(branch: string): void {
  const name = branch.trim();
  if (!name || name.includes(':') || name.includes('+') || name.startsWith('refs/')) {
    throw new Error(
      `Invalid branch "${branch}" — use a simple feature branch name (e.g. feat/playground-rules).`,
    );
  }
  if (name === 'HEAD' || name.includes('@{')) {
    throw new Error(`Invalid branch "${branch}".`);
  }
  if (!FEATURE_BRANCH.test(name)) {
    throw new Error(
      `Invalid branch "${branch}" — letters, digits, ., _, /, and - only.`,
    );
  }
  if (PROTECTED_BRANCH_NAMES.has(name.toLowerCase())) {
    throw new Error(
      `Branch "${branch}" is protected — push and open PRs from a feature branch instead.`,
    );
  }
}

export function assertHeadNotBase(head: string, base: string): void {
  if (head === base) {
    throw new Error('head and base must differ — open PRs from a feature branch into the default branch.');
  }
}
