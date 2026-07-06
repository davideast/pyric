/**
 * Git commit author identity for workspace commits pushed to GitHub.
 * Uses the PAT owner's GitHub profile when available.
 */
import { getAuthenticatedUser, type GitHubUserSummary } from './github-api';
import { getStoredPAT } from './github-auth';

/** Fallback when no GitHub PAT is configured (local checkpoints only). */
export const CHECKPOINT_AUTHOR = {
  name: 'pyric-playground',
  email: 'playground@pyric.dev',
} as const;

export interface GitCommitAuthor {
  name: string;
  email: string;
}

/** Map a GitHub `/user` response to git author fields GitHub will attribute. */
export function authorFromGitHubUser(user: GitHubUserSummary): GitCommitAuthor {
  const name = user.name?.trim() || user.login;
  const email =
    user.email?.trim() || `${user.id}+${user.login}@users.noreply.github.com`;
  return { name, email };
}

/** Resolve commit author — GitHub user when PAT is stored, else playground fallback. */
export async function resolveGitCommitAuthor(): Promise<GitCommitAuthor> {
  try {
    const token = await getStoredPAT();
    if (!token) return CHECKPOINT_AUTHOR;
    const user = await getAuthenticatedUser();
    return authorFromGitHubUser(user);
  } catch {
    return CHECKPOINT_AUTHOR;
  }
}
